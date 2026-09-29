package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	socketRedis "github.com/zishang520/socket.io/adapters/redis/v3"
	redisAdapter "github.com/zishang520/socket.io/adapters/redis/v3/adapter"
	engine "github.com/zishang520/socket.io/servers/engine/v3"
	"github.com/zishang520/socket.io/servers/socket/v3"
	"github.com/zishang520/socket.io/v3/pkg/types"
)

func matchRoom(matchID string) string { return "match:" + matchID }
func userRoom(userID string) string   { return "user:" + userID }

func (a *App) StartRealtime(ctx context.Context) error {
	client := socketRedis.NewRedisClient(ctx, a.Redis)
	options := socket.DefaultServerOptions()
	options.SetServeClient(false)
	options.SetAdapter(&redisAdapter.RedisAdapterBuilder{Redis: client, Opts: redisAdapter.DefaultRedisAdapterOptions()})
	options.SetTransports(types.NewSet(engine.WebSocket))
	options.SetPingInterval(5 * time.Second)
	options.SetPingTimeout(10 * time.Second)
	options.SetMaxHttpBufferSize(8 * 1024)
	server := socket.NewServer(nil, options)
	server.Use(func(client *socket.Socket, next func(*socket.ExtendedError)) {
		handshake := client.Handshake()
		token := ""
		if handshake != nil && handshake.Auth != nil {
			if value, ok := handshake.Auth["accessToken"].(string); ok {
				token = value
			} else if value, ok := handshake.Auth["token"].(string); ok {
				token = value
			}
			if token == "" {
				token = bearerToken(handshake.Headers.Header().Get("Authorization"))
			}
		}
		user, err := a.JWKs.Verify(ctx, token)
		if err != nil {
			next(socket.NewExtendedError("AUTH_EXPIRED", nil))
			return
		}
		if err := a.requireProfile(ctx, user.ID); err != nil {
			next(socket.NewExtendedError("FORBIDDEN", nil))
			return
		}
		client.SetData(user)
		next(nil)
	})
	server.On("connection", func(clients ...any) {
		if len(clients) == 0 {
			return
		}
		client, ok := clients[0].(*socket.Socket)
		if !ok {
			return
		}
		user, ok := client.Data().(User)
		if !ok {
			return
		}
		client.Join(socket.Room(userRoom(user.ID)))
		_ = client.Emit("session.accepted", map[string]any{"protocolVersion": 1, "userId": user.ID, "serverTime": time.Now().UTC()})
		_ = client.On("match.resume", func(args ...any) { a.onMatchResume(ctx, client, user.ID, args...) })
		_ = client.On("match.ready", func(args ...any) { a.onMatchReady(ctx, client, user.ID, args...) })
		_ = client.On("match.rep", func(args ...any) { a.onMatchRep(ctx, client, user.ID, args...) })
		_ = client.On("match.heartbeat", func(args ...any) { a.onMatchHeartbeat(ctx, client, user.ID, args...) })
		_ = client.On("queue.heartbeat", func(args ...any) { a.onQueueHeartbeat(ctx, client, user.ID, args...) })
		_ = client.On("match.leave", func(args ...any) { a.onMatchLeave(ctx, client, user.ID, args...) })
		_ = client.On("disconnect", func(...any) {
			_, err := a.DB.Exec(context.Background(), `update public.match_participants set last_seen_at = now(), connection_state = 'disconnected'
				where user_id = $1 and match_id in (select id from public.matches where state in ('COUNTDOWN','ACTIVE'))`, user.ID)
			if err != nil {
				a.Log.Warn("could not record socket disconnect", "userId", user.ID, "error", err)
			}
		})
	})
	a.Socket = server
	go a.consumeMatchEvents(ctx)
	return nil
}

func bearerToken(header string) string {
	if strings.HasPrefix(header, "Bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

func eventMap(raw any) map[string]any {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var value map[string]any
	if json.Unmarshal(encoded, &value) != nil {
		return nil
	}
	return value
}

func eventAck(args []any) (socket.Ack, map[string]any) {
	if len(args) == 0 {
		return nil, nil
	}
	var ack socket.Ack
	if len(args) > 1 {
		ack, _ = args[len(args)-1].(socket.Ack)
	}
	return ack, eventMap(args[0])
}

func sendAck(ack socket.Ack, value any) {
	if ack != nil {
		ack([]any{value}, nil)
	}
}

func eventRequestID(raw map[string]any) any {
	if raw == nil {
		return nil
	}
	if value, ok := raw["requestId"].(string); ok {
		return value
	}
	return nil
}

func socketError(err error, requestID any) map[string]any {
	appErr, ok := err.(*HTTPError)
	if !ok {
		appErr = fail(500, "SERVICE_UNAVAILABLE", "The service could not complete this request.", true)
	}
	return map[string]any{"ok": false, "error": map[string]any{"code": appErr.Code, "message": appErr.Message, "retryable": appErr.Retryable}, "requestId": requestID}
}

func (a *App) onMatchResume(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	matchID, _ := raw["matchId"].(string)
	if !validProtocol(raw) || !uuidPattern.MatchString(matchID) {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Request data is invalid.", false), requestID))
		return
	}
	snapshot, err := a.matchSnapshot(ctx, userID, matchID, true)
	if err == nil {
		err = a.joinAndHeartbeat(ctx, client, userID, matchID)
	}
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	sendAck(ack, map[string]any{"ok": true, "snapshot": snapshot, "requestId": requestID})
	payload := map[string]any{"protocolVersion": 1}
	for key, value := range snapshot {
		payload[key] = value
	}
	_ = client.Emit("match.snapshot", payload)
}

func (a *App) joinAndHeartbeat(ctx context.Context, client *socket.Socket, userID, matchID string) error {
	client.Join(socket.Room(matchRoom(matchID)))
	_, err := a.heartbeatMatch(ctx, userID, matchID)
	return err
}

func (a *App) onMatchReady(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	matchID, _ := raw["matchId"].(string)
	sessionNonce, _ := raw["sessionNonce"].(string)
	model, _ := raw["modelVersion"].(string)
	if !validProtocol(raw) || !uuidPattern.MatchString(matchID) || len(sessionNonce) < 24 || len(sessionNonce) > 160 || len(model) > 120 {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Request data is invalid.", false), requestID))
		return
	}
	if model != modelVersion {
		sendAck(ack, socketError(fail(409, "RULE_UNSUPPORTED", "Update the app before joining this match.", false), requestID))
		return
	}
	client.Join(socket.Room(matchRoom(matchID)))
	result, err := a.readyMatch(ctx, userID, matchID, sessionNonce)
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	response := map[string]any{"ok": true, "requestId": requestID}
	for key, value := range result {
		response[key] = value
	}
	sendAck(ack, response)
	if result["state"] == "CANCELLED" {
		seq, _ := a.Redis.Incr(ctx, "match-seq:"+matchID).Result()
		_ = a.Socket.To(socket.Room(matchRoom(matchID))).Emit("match.ended", map[string]any{"protocolVersion": 1, "matchId": matchID, "result": result, "serverSeq": seq, "serverTime": time.Now().UTC()})
	} else if result["state"] == "COUNTDOWN" {
		seq, _ := a.Redis.Incr(ctx, "match-seq:"+matchID).Result()
		_ = a.Socket.To(socket.Room(matchRoom(matchID))).Emit("match.countdown", map[string]any{"protocolVersion": 1, "matchId": matchID, "startAt": result["startAt"], "endAt": result["endAt"], "serverSeq": seq})
	}
}

func (a *App) onMatchRep(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	encoded, err := json.Marshal(raw)
	if err != nil {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Rep event data is incomplete or outside protocol bounds.", false), requestID))
		return
	}
	result, err := a.acceptRep(ctx, userID, encoded)
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	response := map[string]any{"ok": true, "requestId": requestID}
	for key, value := range result {
		response[key] = value
	}
	sendAck(ack, response)
	if result["status"] != "accepted" || result["duplicate"] == true {
		return
	}
	matchID, _ := raw["matchId"].(string)
	participants, err := queryRows(ctx, a.DB, "select slot, accepted_count as score from public.match_participants where match_id = $1 order by slot", matchID)
	if err != nil {
		a.Log.Warn("could not read match score", "matchId", matchID, "error", err)
		return
	}
	var player1, player2 int
	for _, item := range participants {
		if integer(item, "slot") == 1 {
			player1 = integer(item, "score")
		} else if integer(item, "slot") == 2 {
			player2 = integer(item, "score")
		}
	}
	seq, _ := a.Redis.Incr(ctx, "match-seq:"+matchID).Result()
	_ = a.Socket.To(socket.Room(matchRoom(matchID))).Emit("match.score", map[string]any{"protocolVersion": 1, "matchId": matchID, "player1": player1, "player2": player2, "eventId": result["eventId"], "provisional": false, "serverTime": time.Now().UTC(), "serverSeq": seq})
}

func (a *App) onMatchHeartbeat(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	matchID, _ := raw["matchId"].(string)
	if !validProtocol(raw) || !uuidPattern.MatchString(matchID) {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Request data is invalid.", false), requestID))
		return
	}
	result, err := a.heartbeatMatch(ctx, userID, matchID)
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	result["requestId"] = requestID
	sendAck(ack, result)
}

func (a *App) onQueueHeartbeat(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	if !validProtocol(raw) {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Request data is invalid.", false), requestID))
		return
	}
	result, err := a.heartbeatQueue(ctx, userID)
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	result["requestId"] = requestID
	sendAck(ack, result)
}

func (a *App) onMatchLeave(ctx context.Context, client *socket.Socket, userID string, args ...any) {
	ack, raw := eventAck(args)
	requestID := eventRequestID(raw)
	matchID, _ := raw["matchId"].(string)
	if !validProtocol(raw) || !uuidPattern.MatchString(matchID) {
		sendAck(ack, socketError(fail(400, "INVALID_REQUEST", "Request data is invalid.", false), requestID))
		return
	}
	result, err := a.leaveMatch(ctx, userID, matchID)
	if err != nil {
		sendAck(ack, socketError(err, requestID))
		return
	}
	sendAck(ack, map[string]any{"ok": true, "result": result, "requestId": requestID})
	a.notifyMatchEnded(ctx, matchID, result)
}

func validProtocol(raw map[string]any) bool {
	return raw != nil && raw["protocolVersion"] == float64(1)
}

func (a *App) notifyMatchEnded(ctx context.Context, matchID string, result any) {
	if a.Socket == nil {
		return
	}
	seq, err := a.Redis.Incr(ctx, "match-seq:"+matchID).Result()
	if err != nil {
		a.Log.Warn("match sequence unavailable", "matchId", matchID, "error", err)
		return
	}
	_ = a.Socket.To(socket.Room(matchRoom(matchID))).Emit("match.ended", map[string]any{"protocolVersion": 1, "matchId": matchID, "result": result, "serverTime": time.Now().UTC(), "serverSeq": seq})
}

func (a *App) disconnectUser(userID string) {
	if a.Socket != nil {
		a.Socket.In(socket.Room(userRoom(userID))).DisconnectSockets(true)
	}
}

func (a *App) consumeMatchEvents(ctx context.Context) {
	sub := a.Redis.Subscribe(ctx, "match-events")
	defer sub.Close()
	for message := range sub.Channel() {
		var event struct {
			Type    string   `json:"type"`
			MatchID string   `json:"matchId"`
			Users   []string `json:"users"`
		}
		if err := json.Unmarshal([]byte(message.Payload), &event); err != nil {
			a.Log.Warn("invalid internal match event", "error", err)
			continue
		}
		if event.Type != "match.found" {
			continue
		}
		for _, userID := range event.Users {
			_ = a.Socket.To(socket.Room(userRoom(userID))).Emit("match.found", map[string]any{"protocolVersion": 1, "matchId": event.MatchID})
		}
	}
}

func (a *App) publishOutbox(ctx context.Context) error {
	if a.Socket == nil {
		return nil
	}
	return a.transaction(ctx, false, func(tx pgx.Tx) error {
		rows, err := queryRows(ctx, tx, `select id, aggregate_id as "aggregateId", event_type as "eventType", payload from public.outbox
			where published_at is null order by created_at for update skip locked limit 50`)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row["eventType"] == "match.settled" {
				matchID := fmt.Sprint(row["aggregateId"])
				seq, err := a.Redis.Incr(ctx, "match-seq:"+matchID).Result()
				if err != nil {
					return err
				}
				payload := map[string]any{"protocolVersion": 1, "serverSeq": seq}
				switch value := row["payload"].(type) {
				case string:
					_ = json.Unmarshal([]byte(value), &payload)
				case []byte:
					_ = json.Unmarshal(value, &payload)
				case map[string]any:
					for key, item := range value {
						payload[key] = item
					}
				}
				_ = a.Socket.To(socket.Room(matchRoom(matchID))).Emit("match.settled", payload)
			}
			if _, err := tx.Exec(ctx, "update public.outbox set published_at = now() where id = $1", row["id"]); err != nil {
				return err
			}
		}
		return nil
	})
}

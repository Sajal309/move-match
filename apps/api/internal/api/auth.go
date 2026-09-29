package api

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksDocument struct {
	Keys []jwk `json:"keys"`
}

type JWKSet struct {
	config     Config
	client     *http.Client
	mu         sync.RWMutex
	keys       map[string]jwk
	refreshed  time.Time
	lastForced time.Time
}

func NewJWKSet(cfg Config) *JWKSet {
	return &JWKSet{config: cfg, client: &http.Client{Timeout: 5 * time.Second}, keys: make(map[string]jwk)}
}

func (set *JWKSet) endpoint() string {
	if set.config.SupabaseJWKSURL != "" {
		return set.config.SupabaseJWKSURL
	}
	return set.config.SupabaseURL + "/auth/v1/.well-known/jwks.json"
}

func (set *JWKSet) issuer() string {
	if set.config.SupabaseIssuer != "" {
		return set.config.SupabaseIssuer
	}
	return set.config.SupabaseURL + "/auth/v1"
}

func (set *JWKSet) refresh(ctx context.Context, force bool) error {
	set.mu.Lock()
	defer set.mu.Unlock()
	now := time.Now()
	if !force && now.Sub(set.refreshed) < 30*time.Minute {
		return nil
	}
	if force && now.Sub(set.lastForced) < 30*time.Second && len(set.keys) != 0 {
		return nil
	}
	if force {
		set.lastForced = now
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, set.endpoint(), nil)
	if err != nil {
		return err
	}
	response, err := set.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("could not load signing keys")
	}
	var document jwksDocument
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&document); err != nil {
		return err
	}
	keys := make(map[string]jwk, len(document.Keys))
	for _, key := range document.Keys {
		if key.Kid != "" {
			keys[key.Kid] = key
		}
	}
	if len(keys) == 0 {
		return errors.New("signing-key set is empty")
	}
	set.keys = keys
	set.refreshed = now
	return nil
}

func (set *JWKSet) Verify(ctx context.Context, token string) (User, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return User{}, errors.New("invalid token")
	}
	decode := base64.RawURLEncoding.DecodeString
	headerBytes, err := decode(parts[0])
	if err != nil {
		return User{}, err
	}
	claimsBytes, err := decode(parts[1])
	if err != nil {
		return User{}, err
	}
	var header struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
	}
	var claims map[string]any
	if json.Unmarshal(headerBytes, &header) != nil || json.Unmarshal(claimsBytes, &claims) != nil || header.KeyID == "" {
		return User{}, errors.New("invalid token header or claims")
	}
	if header.Algorithm != "ES256" && header.Algorithm != "RS256" {
		return User{}, errors.New("unsupported token algorithm")
	}
	set.mu.RLock()
	key, found := set.keys[header.KeyID]
	stale := time.Since(set.refreshed) >= 30*time.Minute
	set.mu.RUnlock()
	if !found || stale {
		if err := set.refresh(ctx, !found); err != nil {
			return User{}, err
		}
		set.mu.RLock()
		key, found = set.keys[header.KeyID]
		set.mu.RUnlock()
	}
	if !found || !verifyJWK(key, header.Algorithm, parts[0]+"."+parts[1], parts[2]) {
		return User{}, errors.New("token signature is invalid")
	}
	now := float64(time.Now().Unix())
	if exp, ok := claims["exp"].(float64); ok && now > exp+10 {
		return User{}, errors.New("token expired")
	}
	if nbf, ok := claims["nbf"].(float64); ok && now+10 < nbf {
		return User{}, errors.New("token not active")
	}
	if claims["iss"] != set.issuer() || !hasAudience(claims["aud"], set.config.SupabaseAudience) {
		return User{}, errors.New("token issuer or audience is invalid")
	}
	sub, _ := claims["sub"].(string)
	role, _ := claims["role"].(string)
	anonymous, _ := claims["is_anonymous"].(bool)
	if sub == "" || role != "authenticated" || anonymous {
		return User{}, errors.New("token is not an authenticated account session")
	}
	email, _ := claims["email"].(string)
	iat, _ := claims["iat"].(float64)
	return User{ID: sub, Email: email, IAT: int64(iat)}, nil
}

func hasAudience(raw any, expected string) bool {
	switch value := raw.(type) {
	case string:
		return value == expected
	case []any:
		for _, item := range value {
			if item == expected {
				return true
			}
		}
	}
	return false
}

func verifyJWK(key jwk, algorithm, message, encodedSignature string) bool {
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(message))
	switch algorithm {
	case "ES256":
		if key.Kty != "EC" || key.Crv != "P-256" || len(signature) != 64 {
			return false
		}
		x, errX := base64.RawURLEncoding.DecodeString(key.X)
		y, errY := base64.RawURLEncoding.DecodeString(key.Y)
		if errX != nil || errY != nil {
			return false
		}
		publicKey := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		return ecdsa.Verify(publicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
	case "RS256":
		if key.Kty != "RSA" {
			return false
		}
		modulus, errN := base64.RawURLEncoding.DecodeString(key.N)
		exponentBytes, errE := base64.RawURLEncoding.DecodeString(key.E)
		if errN != nil || errE != nil || len(exponentBytes) == 0 || len(exponentBytes) > 4 {
			return false
		}
		exponent := 0
		for _, value := range exponentBytes {
			exponent = exponent<<8 | int(value)
		}
		publicKey := &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: exponent}
		return rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], signature) == nil
	}
	return false
}

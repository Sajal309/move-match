# MOVE / MATCH

React Native iOS and Android app for camera-counted practice and 1v1 exercise challenges. Pose inference is implemented in a custom native MediaPipe module. Camera frames and complete pose streams remain on the device; the online protocol sends numeric repetition summaries only.

The repository contains mobile app source, a Fastify/Postgres/Redis service, SQL migrations, deterministic push-up and pull-up repetition engines, and the native pose module. Online services and ranked exercise flags start disabled. Source implementation is not evidence of physical-device or production readiness; see [implementation status](docs/IMPLEMENTATION_STATUS.md) and [native compatibility](docs/COMPATIBILITY.md).

## Requirements

- Node.js 22.13 or later and pnpm 11
- Xcode 26.4+ and CocoaPods 1.16+ for iOS native builds
- JDK 17, Android SDK/NDK and Gradle dependencies for Android native builds
- A physical iOS and Android phone for camera/tracking and cross-platform match validation
- Supabase, PostgreSQL, Redis and a configured email provider for online features

Expo Go is not supported. A development client is required for the camera and custom native module.

## Install and run locally

1. Install locked dependencies: `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to `.env` and add only local/public client values to `EXPO_PUBLIC_*`. Never put a server secret in a mobile variable.
3. Fetch and verify the official model when needed: `pnpm model:fetch`.
4. Generate Nitro sources and Expo native projects: `pnpm native:prebuild`.
5. Build a development client with `pnpm ios` or `pnpm android`; these commands require the platform toolchains and a device or simulator.
6. Run the mobile bundler with `pnpm dev` after installing the development client.

With Xcode 27, open **Device Hub** to see and interact with the iOS simulator: `open /Applications/Xcode.app/Contents/Applications/DeviceHub.app`. The installed app is **MOVE / MATCH**. Keep Metro running while testing a Debug build.

For a physical phone, set `EXPO_PUBLIC_API_URL` to a reachable HTTPS URL or your computer’s LAN address; `localhost` on the phone points back to the phone itself.

The API uses private server variables in `.env.example`. Apply the migration with `pnpm db:migrate`, then run `pnpm api:dev`. Supabase email OTP, private PostgreSQL and Redis must already be provisioned. The public account-deletion page is served at `/account-deletion` after deployment and requires `PUBLIC_SUPPORT_EMAIL`.

## Project map

- `apps/mobile` — Expo Router application and local camera/practice flows
- `apps/api` — authenticated REST and Socket.IO service
- `modules/pose-tracker` — owned Swift/Kotlin MediaPipe implementation and model bundle
- `packages/rep-engine` — versioned local movement state machines
- `packages/contracts` — shared API/event schemas
- `supabase/migrations` — server schema, RLS and initial feature flags
- `docs/OPERATIONS.md` — private service configuration, rollout and recovery notes

# Tunec

A local VPN tunnel that intercepts TCP traffic from one Android app and relays it through an external Node.js server.

## Architecture

```
AppTwo  ──TCP──▶  TUN device  ──▶  AppOne (VPN service)
                                      │
                                      │  WebSocket (JSON)
                                      ▼
                                   AppBack (Node.js)
                                      │
                                      │  TCP
                                      ▼
                                 Destination server
```

- **app-one** – Android VPN service (`com.tunec.appone`). Captures all TCP traffic from AppTwo via a TUN interface, parses IP/TCP headers, and forwards relay requests to AppBack over WebSocket. Receives responses and injects them back into the TUN device as crafted IP/TCP packets.
- **app-two** – Android client app (`com.tunec.apptwo`). A simple HTTP client whose traffic is routed through the VPN. Displays response code and round-trip time.
- **app-back** – Node.js/TypeScript WebSocket relay server. Receives connection/data requests from AppOne, opens real TCP sockets to destination servers, and streams responses back.

### Communication format

AppOne and AppBack communicate over **WebSocket** using **JSON** messages with base64-encoded binary payloads.

**Requests (AppOne → AppBack):**
- `connect` – open a TCP connection to a destination host:port
- `data` – forward payload bytes to an existing connection
- `disconnect` – close a connection

**Responses (AppBack → AppOne):**
- `connected` – TCP connection established
- `data` – payload received from the destination server
- `disconnected` – connection closed
- `error` – connection or relay error

## Tech stack

| Component | Stack |
|-----------|-------|
| app-one   | Kotlin, Jetpack Compose, OkHttp (WebSocket), Android VPN API |
| app-two   | Kotlin, Jetpack Compose, OkHttp |
| app-back  | Node.js, TypeScript, Express, ws |

## Setup

- **Android SDK**: Set `ANDROID_HOME` to your SDK path, or create `local.properties` in the project root with `sdk.dir=/path/to/android/sdk`. Android Studio does this automatically.
- **Gradle wrapper**: If `./gradlew` fails with a missing `gradle-wrapper.jar`, run once: `gradle wrapper --gradle-version=8.5` (or use Android Studio).
- **Node.js**: Required for app-back. Install dependencies with `npm install` in the `app-back/` directory.

## Configuration

The WebSocket server URL is configured in `app-one/src/main/kotlin/com/tunec/appone/TunecVpnService.kt`:

```kotlin
private const val APP_BACK_URL = "ws://192.168.1.93:3000"
```

Change this to the IP address of the machine running AppBack.

## Build & Run

### 1. Start AppBack

```bash
cd app-back
npm install
npm run dev
```

The server listens on port 3000 by default (override with `PORT` env variable).

### 2. Build Android apps

```bash
# Both apps
./gradlew :app-one:assembleDebug :app-two:assembleDebug

# Single app
./gradlew :app-one:assembleDebug
./gradlew :app-two:assembleDebug
```

### 3. Install on device

```bash
./gradlew :app-one:installDebug
./gradlew :app-two:installDebug
```

Or choose the app module in Android Studio and run.

### 4. Usage

1. Open **AppOne** and tap **Connect to VPN** (grant VPN permission when prompted).
2. Open **AppTwo** and tap **Запросить** — the request will be routed through AppOne → AppBack → destination server.
3. AppTwo displays the HTTP response code and round-trip time in milliseconds.
4. To stop, open **AppOne** and tap **Disconnect VPN**.

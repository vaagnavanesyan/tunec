# Tunec

Two independent Android applications in a single Gradle multi-project.

## Structure

- **app-one** – first app (`applicationId`: `com.tunec.appone`)
- **app-two** – second app (`applicationId`: `com.tunec.apptwo`)

Kotlin + Jetpack Compose, minSdk 24, targetSdk 34.

## Setup

- **Android SDK**: Set `ANDROID_HOME` to your SDK path, or create `local.properties` in the project root with `sdk.dir=/path/to/android/sdk`. Android Studio does this automatically.
- **Gradle wrapper**: If `./gradlew` fails with a missing `gradle-wrapper.jar`, run once: `gradle wrapper --gradle-version=8.5` (or use Android Studio).

## Build

From the project root:

```bash
# Both apps
./gradlew :app-one:assembleDebug :app-two:assembleDebug

# Single app
./gradlew :app-one:assembleDebug
./gradlew :app-two:assembleDebug
```

## Run

Install and run on a device or emulator:

```bash
./gradlew :app-one:installDebug
./gradlew :app-two:installDebug
```

Or choose the app module in Android Studio and run.

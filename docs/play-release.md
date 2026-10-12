# Releasing the Android app to Google Play

The full Play Console walkthrough lives in the shared "Google Play release checklist" doc. This page covers the parts that live in this repo.

## One-time: create the upload key

Play App Signing holds the real app signing key. You sign uploads with your own **upload key**, which never goes in the repo.

`keytool` comes with any Java install. In PowerShell, check for it with `where.exe keytool`; if nothing is found, install Java with `winget install EclipseAdoptium.Temurin.21.JDK` and open a new window. Then:

```powershell
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Make a new key for this app rather than reusing another app's keystore, especially one that holds that app's own signing key.

Use one password for both the keystore and the key (the default PKCS12 format requires that). Back up `upload.jks` and the password somewhere safe outside the repo, such as a password manager. If you lose it, Google can reset the upload key, but it takes a support request.

## One-time: add the GitHub secrets

In the repo, open **Settings > Secrets and variables > Actions > New repository secret** and add:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file as base64 (command below) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `upload` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the same password |

To copy the base64 to the clipboard in PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("upload.jks")) | Set-Clipboard
```

## Each release

1. On GitHub, open **Actions > Android release > Run workflow**.
2. Enter the version name (for example `0.2.0`). Leave the version code empty to use the run number, which goes up by one every run, so each upload gets a higher code as Play requires.
3. Download the `watch-party-<version>-aab` artifact, unzip it, and upload the `.aab` in Play Console.

Pull request builds and the plain **Android** workflow still produce a debug-signed APK for sideloading, so the secrets are only needed for Play uploads.

## Privacy policy

`docs/privacy.md` is the app's privacy policy. To host it, open **Settings > Pages**, choose **Deploy from a branch**, branch `main`, folder `/docs`. It is then at `https://cheesesoda.github.io/watch-party/privacy/`, which is the URL to give Play Console.

## Store graphics

`docs/store/tv-banner-1280x720.png` is the Android TV banner for the Play listing. It matches the in-app launcher banner, which carries the app name as the TV quality rules require.

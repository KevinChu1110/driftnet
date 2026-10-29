# driftnet Chrome extension: privacy policy

_Last updated: 2026-10-29_

The driftnet extension sends the page you are looking at to **your own driftnet server**, and
nowhere else. The developer of the extension does not run any server that receives your data.

## What the extension reads

- **The text, title, address and links of the tab you click on**, and only at the moment you
  click the toolbar button or use the right-click menu ("Send this page / link / selection to
  driftnet"). On Threads, X and Instagram it also reads the replies or comments visible on that
  page (a bounded number) and expands "See more" / "View replies" buttons on it.
- **Your settings**: the server address and an optional access token, stored in the browser's
  local extension storage on your computer.

The extension does not read tabs in the background, does not watch your browsing, and does not
read pages you did not ask it to send.

## Where the data goes

What was read is sent, in one request, to the server address you entered in the extension's
settings (by default `http://localhost:8787`, a driftnet server running on your own computer).
That server is software you install and control; what it does with the data (summarising it,
optionally with the language-model provider you configured) is described in the
[driftnet README](https://github.com/KevinChu1110/driftnet#readme).

Servers other than localhost require an `https://` address, and the extension asks your
permission for that one address before connecting.

## What we do not do

- No analytics, telemetry, crash reporting or advertising.
- No accounts. The developer receives nothing from the extension.
- No selling or sharing of data, no use of data for purposes unrelated to the extension's single
  purpose, no creditworthiness or lending use.
- No remote code: every script runs from the package you installed.

## Your control

Remove the extension to remove its stored settings. Items sent to your server are managed in
your driftnet catalogue, which you can delete from at any time.

## Contact

Questions or concerns: open an issue at <https://github.com/KevinChu1110/driftnet/issues>.

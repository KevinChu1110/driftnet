[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/install-beginners.md)

# Install for beginners

Never used a terminal? This takes about five minutes. You type one command; driftnet does the rest and
opens its page in your browser. Nothing is installed in the cloud and there is no account.

## 1. Install Node.js (once)

driftnet runs on Node.js, a free program that runs JavaScript on your computer.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version (any version 22.13 or newer works).
2. Open the downloaded file and click through the installer with the default choices.

## 2. Open a terminal

- **Mac:** press <kbd>⌘ Command</kbd> + <kbd>Space</kbd>, type **Terminal**, press <kbd>Enter</kbd>.
- **Windows:** press the <kbd>Windows</kbd> key, type **PowerShell**, press <kbd>Enter</kbd>.

A window with a blinking cursor opens. That is the terminal.

## 3. Start driftnet

Paste this line into the terminal and press <kbd>Enter</kbd>:

```bash
npx driftnet
```

The first time, it may ask `Ok to proceed? (y)`: type <kbd>y</kbd> and press <kbd>Enter</kbd>. After a
moment your browser opens **http://localhost:8787**. That is driftnet's page, served by your own
computer (*localhost* means "this computer"; nobody else can see it).

If the browser does not open by itself, open it yourself and go to `http://localhost:8787`.

## 4. Keep the window open

**driftnet runs only while that terminal window is open.** You can minimise it, but closing it (or
restarting the computer) stops driftnet. Next time, open a terminal and run `npx driftnet` again: your
links and settings are kept.

To have it start by itself at login you currently need the from-source install
(`pnpm service:install`, macOS and Linux only); see *Other ways to run it* in the [README](../README.md#-quick-start).

## 5. Add links

- Install the [Chrome extension](chrome-extension.md) and click it on any page to save that page.
- Or paste a link into the box on the driftnet page.

To have cards sorted and explained, open ⚙ Settings → AI on the page and pick a provider: a free model on
your computer (Ollama), a subscription you already have (Claude or Gemini), or an API key. See
[Models](models.md). Without one, links are still saved and wait unsorted under "Other".

## Something went wrong?

- **`npx` is not recognised / command not found:** Node.js is not installed yet, or the terminal was
  open before you installed it. Close the terminal, open a new one and try again.
- **`driftnet needs Node 22.13 or newer`:** download the current LTS from [nodejs.org](https://nodejs.org) and install it over the old one.
- **Windows says running scripts is disabled:** in PowerShell, run `npx.cmd driftnet` instead.
- More in *Not working?* in the [README](../README.md#-quick-start).

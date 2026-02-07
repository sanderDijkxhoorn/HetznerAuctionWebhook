# Hetzner Auction Webhook

Monitors the Hetzner Server Auction feed, filters matches, posts to Discord, tracks price drops, and stores snapshots for history.

## Setup

1. Clone the repo

```bash
git clone https://github.com/sanderDijkxhoorn/HetznerAuctionWebhook.git
```
```bash
cd HetznerAuctionWebhook
```

2. Create your config

```bash
cp config.json.example config.json
```

3. Configure

Open [config.json](config.json) and set:

- `discordWebhookUrl`
- `taxPercent` (e.g., 21 for Netherlands)
- `filters` (RAM, ECC, CPU vendor, max price, NVMe)
- `hetznerApiUrl` (EUR or USD)
  - https://www.hetzner.com/_resources/app/data/app/live_data_sb_EUR.json
  - https://www.hetzner.com/_resources/app/data/app/live_data_sb_USD.json

4. Run

```bash
node index.js
```

Or run with PM2:

```bash
pm2 start index.js --name HetznerAuctionWebhook
```

## Notes

- The script polls continuously using `polling.intervalMs` in config.
- Posts are deduped, but price drops trigger a new alert.
- Snapshots are saved in the history folder.

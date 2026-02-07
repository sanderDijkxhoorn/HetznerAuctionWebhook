"use strict";

const fs = require("fs/promises");
const path = require("path");

const DEFAULT_CONFIG = {
  hetznerApiUrl:
    "https://www.hetzner.com/_resources/app/data/app/live_data_sb_EUR.json",
  discordWebhookUrl: "https://discord.com/api/webhooks/REPLACE_ME",
  taxPercent: 0,
  filters: {
    minRamGb: 128,
    requireEcc: true,
    cpuVendors: ["AMD"],
    maxPriceEur: 100,
    minNvmeTb: 3,
  },
  storage: {
    postedIdsFile: "posted_ids.json",
    historyDir: "history",
  },
  polling: {
    intervalMs: 5000,
  },
  webhook: {
    username: "Hetzner Auction",
  },
};

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
};

const writeJsonFile = async (filePath, data) => {
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json + "\n", "utf8");
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const loadConfig = async () => {
  try {
    const config = await readJsonFile(CONFIG_PATH);
    return config;
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
      throw new Error(
        "config.json was created. Please update discordWebhookUrl and re-run.",
      );
    }
    throw error;
  }
};

const fetchLiveData = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Hetzner API request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
};

const formatDateForFilename = (date) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const saveHistorySnapshot = async (historyDir, data) => {
  await ensureDir(historyDir);
  const stamp = formatDateForFilename(new Date());
  const fileName = `live_data_sb_EUR_${stamp}.json`;
  const filePath = path.join(historyDir, fileName);
  await writeJsonFile(filePath, data);
  return filePath;
};

const loadLatestHistorySnapshot = async (historyDir) => {
  try {
    const entries = await fs.readdir(historyDir);
    const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));
    if (jsonFiles.length === 0) {
      return null;
    }

    const fileStats = await Promise.all(
      jsonFiles.map(async (file) => {
        const fullPath = path.join(historyDir, file);
        const stats = await fs.stat(fullPath);
        return { file, fullPath, mtimeMs: stats.mtimeMs };
      }),
    );

    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = fileStats[0];
    return readJsonFile(latest.fullPath, null);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const normalizeCpu = (cpu) => String(cpu || "").toLowerCase();

const parseDiskSizeGb = (text) => {
  if (!text) {
    return 0;
  }
  const normalized = String(text).replace(",", ".");
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(tb|gb)/i);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (Number.isNaN(value)) {
    return 0;
  }
  return unit === "tb" ? value * 1000 : value;
};

const getNvmeTotalGb = (server) => {
  const nvmeArray = server?.serverDiskData?.nvme;
  if (Array.isArray(nvmeArray) && nvmeArray.length > 0) {
    return nvmeArray.reduce((sum, size) => sum + Number(size || 0), 0);
  }

  const disks = Array.isArray(server?.hdd_arr) ? server.hdd_arr : [];
  return disks
    .filter((disk) => /nvme/i.test(disk))
    .reduce((sum, disk) => sum + parseDiskSizeGb(disk), 0);
};

const matchesFilters = (server, filters) => {
  const ramOk = Number(server?.ram_size || 0) >= filters.minRamGb;
  const eccOk = filters.requireEcc ? Boolean(server?.is_ecc) : true;
  const cpuOk = filters.cpuVendors.some((vendor) =>
    normalizeCpu(server?.cpu).includes(vendor.toLowerCase()),
  );
  const nvmeTotalGb = getNvmeTotalGb(server);
  const nvmeOk = nvmeTotalGb >= filters.minNvmeTb * 1000;

  return ramOk && eccOk && cpuOk && nvmeOk;
};

const loadPostedIds = async (filePath) => {
  const ids = await readJsonFile(filePath, []);
  return new Set(ids.map((id) => String(id)));
};

const savePostedIds = async (filePath, ids) => {
  const list = Array.from(ids).sort();
  await writeJsonFile(filePath, list);
};

const formatNvmeTb = (server) => {
  const totalGb = getNvmeTotalGb(server);
  if (!totalGb) {
    return "0 TB";
  }
  const totalTb = totalGb / 1000;
  return `${totalTb.toFixed(2)} TB`;
};

const formatServerMessage = (server, previousData, taxPercent) => {
  const ramLabel = `${server?.ram_size || "?"} GB${server?.is_ecc ? " ECC" : ""}`;
  const taxValue = Number(taxPercent || 0);
  const priceWithTax = Number(server?.price || 0) * (1 + taxValue / 100);
  const priceDisplayLabel =
    taxValue > 0
      ? `${priceWithTax.toFixed(2)} € (incl. ${taxValue}% tax)`
      : `${server?.price ?? "?"} €`;
  let previousPriceLine = null;

  if (previousData && Array.isArray(previousData.server)) {
    const previousServer = previousData.server.find(
      (item) => String(item?.id) === String(server?.id),
    );
    if (
      previousServer &&
      previousServer.price !== undefined &&
      previousServer.price !== server?.price
    ) {
      previousPriceLine = `**Previous Price:** ${previousServer.price} €`;
    }
  }

  return [
    `**Hetzner Server Auction Match**`,
    `**ID:** ${server?.id ?? "unknown"}`,
    server?.id
      ? `**Link:** https://www.hetzner.com/sb/#search=${server.id}`
      : null,
    `**CPU:** ${server?.cpu ?? "unknown"}`,
    `**RAM:** ${ramLabel}`,
    `**NVMe Total:** ${formatNvmeTb(server)}`,
    `**Price:** ${priceDisplayLabel}`,
    previousPriceLine,
    `**Datacenter:** ${server?.datacenter_hr ?? server?.datacenter ?? "unknown"}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const postToDiscord = async (webhookUrl, payload) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Discord webhook failed: ${response.status} ${response.statusText} - ${text}`,
    );
  }
};

const createPoller = (config) => {
  const historyDir = path.join(
    ROOT_DIR,
    config.storage?.historyDir || "history",
  );
  const postedIdsPath = path.join(
    ROOT_DIR,
    config.storage?.postedIdsFile || "posted_ids.json",
  );
  let isRunning = false;

  const poll = async () => {
    if (isRunning) {
      return;
    }
    isRunning = true;
    try {
      const previousSnapshot = await loadLatestHistorySnapshot(historyDir);
      const data = await fetchLiveData(config.hetznerApiUrl);
      await saveHistorySnapshot(historyDir, data);

      const servers = Array.isArray(data?.server) ? data.server : [];
      const matches = servers.filter((server) => {
        const taxValue = Number(config.taxPercent || 0);
        const priceWithTax = Number(server?.price || 0) * (1 + taxValue / 100);
        const priceOkWithTax = priceWithTax <= config.filters.maxPriceEur;
        return matchesFilters(server, config.filters) && priceOkWithTax;
      });

      const postedIds = await loadPostedIds(postedIdsPath);
      let newPosts = 0;

      for (const server of matches) {
        const serverId = String(server?.id ?? "");
        if (!serverId || postedIds.has(serverId)) {
          continue;
        }

        const content = formatServerMessage(
          server,
          previousSnapshot,
          config.taxPercent,
        );
        const payload = {
          username: config.webhook?.username || "Hetzner Auction",
          content,
        };

        await postToDiscord(config.discordWebhookUrl, payload);
        postedIds.add(serverId);
        newPosts += 1;
      }

      await savePostedIds(postedIdsPath, postedIds);

      console.log(`Matches: ${matches.length}, New posts: ${newPosts}`);
    } catch (error) {
      console.error(error.message || error);
    } finally {
      isRunning = false;
    }
  };

  return poll;
};

const run = async () => {
  const config = await loadConfig();
  const intervalMs = Number(config.polling?.intervalMs || 5000);
  const poll = createPoller(config);

  await poll();
  setInterval(poll, intervalMs);
};

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

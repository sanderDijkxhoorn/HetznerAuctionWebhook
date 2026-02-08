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
    minNvmeTb: 3.5,
  },
  storage: {
    postedStateFile: "posted_state.json",
    historyDir: "history",
  },
  pricing: {
    includeIpPrice: true,
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

const normalizePostedState = (raw) => {
  if (Array.isArray(raw)) {
    return raw.reduce((state, id) => {
      state[String(id)] = { lastPriceWithTax: null };
      return state;
    }, {});
  }
  if (raw && typeof raw === "object") {
    return raw;
  }
  return {};
};

const loadPostedState = async (filePath) => {
  const state = await readJsonFile(filePath, {});
  return normalizePostedState(state);
};

const savePostedState = async (filePath, state) => {
  await writeJsonFile(filePath, state);
};

const formatNvmeTb = (server) => {
  const totalGb = getNvmeTotalGb(server);
  if (!totalGb) {
    return "0 TB";
  }
  const totalTb = totalGb / 1000;
  return `${totalTb.toFixed(2)} TB`;
};

const getBaseMonthlyPrice = (server, includeIpPrice) => {
  const basePrice = Number(server?.price || 0);
  const ipPrice = includeIpPrice ? Number(server?.ip_price?.Monthly || 0) : 0;
  return basePrice + ipPrice;
};

const formatPriceWithTax = (basePrice, taxPercent) => {
  const taxValue = Number(taxPercent || 0);
  const priceWithTax = basePrice * (1 + taxValue / 100);
  return taxValue > 0
    ? `${priceWithTax.toFixed(2)} € (incl. ${taxValue}% tax)`
    : `${basePrice.toFixed(2)} €`;
};

const getPriceWithTaxValue = (basePrice, taxPercent) => {
  const taxValue = Number(taxPercent || 0);
  return basePrice * (1 + taxValue / 100);
};

const formatServerEmbed = (
  server,
  previousData,
  taxPercent,
  includeIpPrice,
  isPriceUpdate,
) => {
  const ramLabel = `${server?.ram_size || "?"} GB${server?.is_ecc ? " ECC" : ""}`;
  const basePrice = getBaseMonthlyPrice(server, includeIpPrice);
  const priceDisplayLabel = formatPriceWithTax(basePrice, taxPercent);
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
      const previousBasePrice = getBaseMonthlyPrice(
        previousServer,
        includeIpPrice,
      );
      previousPriceLine = formatPriceWithTax(previousBasePrice, taxPercent);
    }
  }

  const title = isPriceUpdate ? "Price Update" : "New Match";
  const serverId = server?.id ?? "unknown";
  const url = server?.id
    ? `https://www.hetzner.com/sb/#search=${server.id}`
    : undefined;

  const fields = [
    { name: "ID", value: String(serverId), inline: true },
    { name: "CPU", value: String(server?.cpu ?? "unknown"), inline: true },
    { name: "RAM", value: ramLabel, inline: true },
    { name: "NVMe Total", value: formatNvmeTb(server), inline: true },
    { name: "Price", value: priceDisplayLabel, inline: true },
    {
      name: "Datacenter",
      value: String(server?.datacenter_hr ?? server?.datacenter ?? "unknown"),
      inline: true,
    },
  ];

  if (previousPriceLine) {
    fields.push({
      name: "Previous Price",
      value: previousPriceLine,
      inline: true,
    });
  }

  return {
    title,
    url,
    color: isPriceUpdate ? 0xffc107 : 0x2f3136,
    fields,
    footer: { text: "Hetzner Server Auction" },
    timestamp: new Date().toISOString(),
  };
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
  const postedStatePath = path.join(
    ROOT_DIR,
    config.storage?.postedStateFile || "posted_state.json",
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
      const includeIpPrice = config.pricing?.includeIpPrice !== false;
      const matches = servers.filter((server) => {
        const basePrice = getBaseMonthlyPrice(server, includeIpPrice);
        const priceWithTax =
          basePrice * (1 + Number(config.taxPercent || 0) / 100);
        const priceOkWithTax = priceWithTax <= config.filters.maxPriceEur;
        return matchesFilters(server, config.filters) && priceOkWithTax;
      });

      const postedState = await loadPostedState(postedStatePath);
      let newPosts = 0;

      for (const server of matches) {
        const serverId = String(server?.id ?? "");
        if (!serverId) {
          continue;
        }

        const basePrice = getBaseMonthlyPrice(server, includeIpPrice);
        const priceWithTaxValue = getPriceWithTaxValue(
          basePrice,
          config.taxPercent,
        );
        const lastState = postedState[serverId];
        const lastPriceWithTax = lastState?.lastPriceWithTax ?? null;
        const isPriceUpdate =
          lastPriceWithTax !== null && priceWithTaxValue < lastPriceWithTax;
        const isFirstPost = !lastState;

        if (!isFirstPost && !isPriceUpdate) {
          continue;
        }

        const embed = formatServerEmbed(
          server,
          previousSnapshot,
          config.taxPercent,
          includeIpPrice,
          isPriceUpdate,
        );
        const payload = {
          username: config.webhook?.username || "Hetzner Auction",
          embeds: [embed],
        };

        await postToDiscord(config.discordWebhookUrl, payload);
        postedState[serverId] = {
          lastPriceWithTax: priceWithTaxValue,
          lastPostedAt: new Date().toISOString(),
        };
        newPosts += 1;
      }

      await savePostedState(postedStatePath, postedState);

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

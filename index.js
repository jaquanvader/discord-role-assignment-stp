require("dotenv").config();
const db = require("./db");
const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

const {
  DISCORD_TOKEN,
  GUILD_ID,
  ACCESS_ROLE_ID,
  PAYMENT_LINK,
  TRIAL_HOURS = "48",
  MIN_ACCOUNT_AGE_DAYS = "0",
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !ACCESS_ROLE_ID || !PAYMENT_LINK) {
  throw new Error("Missing env vars: DISCORD_TOKEN, GUILD_ID, ACCESS_ROLE_ID, PAYMENT_LINK");
}

const TRIAL_MS = parseInt(TRIAL_HOURS, 10) * 60 * 60 * 1000;
const MIN_AGE_MS = parseInt(MIN_ACCOUNT_AGE_DAYS, 10) * 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // REQUIRED for join events + role management
    GatewayIntentBits.DirectMessages,   // For DMs
  ],
  partials: [Partials.Channel], // Required for DMs
});

const now = () => Date.now();

function getUser(userId) {
  return db.prepare(`SELECT * FROM users WHERE discord_user_id=?`).get(userId);
}

function markJoin(userId) {
  db.prepare(`
    INSERT INTO users (discord_user_id, last_join_at)
    VALUES (?, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET last_join_at=excluded.last_join_at
  `).run(userId, now());
}

function startTrial(userId, expiresAt) {
  db.prepare(`
    INSERT INTO users (discord_user_id, trial_used, trial_expires_at, last_join_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET
      trial_used=1,
      trial_expires_at=excluded.trial_expires_at,
      last_join_at=excluded.last_join_at
  `).run(userId, expiresAt, now());
}

function clearTrialExpiry(userId) {
  db.prepare(`UPDATE users SET trial_expires_at=NULL WHERE discord_user_id=?`).run(userId);
}

function getExpiredTrials() {
  return db
    .prepare(`SELECT discord_user_id FROM users WHERE trial_expires_at IS NOT NULL AND trial_expires_at <= ?`)
    .all(now());
}

async function safeDM(user, content) {
  try {
    await user.send({ content });
  } catch {
    // DMs closed or blocked; ignore
  }
}

function welcomeDM(userId) {
  return [
    `Hey <@${userId}> — welcome to **SplitThePicks** 🟣`,
    ``,
    `We leak **famous sports cappers’ picks daily** so you don’t have to pay full price.`,
    ``,
    `✅ I just activated your **${TRIAL_HOURS}-hour VIP trial** — go check the **VIP Picks** category now.`,
    ``,
    `If you want to keep access after the trial ends, I’ll send you the instant upgrade link 🔐`,
  ].join("\n");
}

function expiredDM(userId) {
  return [
    `Hey <@${userId}> — your **free VIP trial just ended** ⏳`,
    ``,
    `Don’t lose access to the VIP capper picks.`,
    ``,
    `✅ Re-activate VIP instantly here:`,
    `${PAYMENT_LINK}`,
    ``,
    `Once you checkout, your access is restored automatically.`,
  ].join("\n");
}

function noTrialDM(userId) {
  return [
    `Hey <@${userId}> — welcome back 🟣`,
    ``,
    `Your free trial has already been used on this Discord account.`,
    ``,
    `✅ Get instant VIP access here:`,
    `${PAYMENT_LINK}`,
  ].join("\n");
}

client.on("guildMemberAdd", async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  markJoin(member.user.id);

  // Optional anti-alt: require account age
  if (MIN_AGE_MS > 0) {
    const age = now() - member.user.createdTimestamp;
    if (age < MIN_AGE_MS) {
      await safeDM(
        member.user,
        `Hey <@${member.user.id}> — quick security check: your Discord account is too new to receive a free trial.\n\n✅ You can still get instant VIP access here:\n${PAYMENT_LINK}`
      );
      return;
    }
  }

  const accessRole = member.guild.roles.cache.get(ACCESS_ROLE_ID);
  if (!accessRole) return;

  const row = getUser(member.user.id);

  // If they already have the access role (e.g. Payroll assigns instantly), do nothing.
  if (member.roles.cache.has(ACCESS_ROLE_ID)) return;

  // One-time trial
  if (!row || row.trial_used === 0) {
    const expiresAt = now() + TRIAL_MS;
    startTrial(member.user.id, expiresAt);

    await member.roles.add(accessRole, "Granting trial access").catch(() => null);
    await safeDM(member.user, welcomeDM(member.user.id));
  } else {
    await safeDM(member.user, noTrialDM(member.user.id));
  }
});

async function runExpirySweep() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const accessRole = await guild.roles.fetch(ACCESS_ROLE_ID).catch(() => null);
  if (!accessRole) return;

  const expired = getExpiredTrials();
  for (const { discord_user_id } of expired) {
    // Clear expiry immediately to avoid looping if errors occur
    clearTrialExpiry(discord_user_id);

    const member = await guild.members.fetch(discord_user_id).catch(() => null);
    if (!member) continue;

    // If they still have access role, remove it (trial ended)
    if (member.roles.cache.has(ACCESS_ROLE_ID)) {
      await member.roles.remove(accessRole, "Trial expired").catch(() => null);
    }

    await safeDM(member.user, expiredDM(discord_user_id));
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await runExpirySweep();
  setInterval(runExpirySweep, 60 * 1000);
});

client.login(DISCORD_TOKEN);

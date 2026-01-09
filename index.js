require("dotenv").config();
const db = require("./db");
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const {
  DISCORD_TOKEN,
  GUILD_ID,
  ACCESS_ROLE_IDS,   // comma-separated role IDs for gate roles ONLY: g2,g3,g4,g5
  PAYROLL_ROLE_ID,   // g1 role id (the one Payroll toggles on/off)
  PAYMENT_LINK,
  TRIAL_HOURS = "48",
  MIN_ACCOUNT_AGE_DAYS = "3",
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !ACCESS_ROLE_IDS || !PAYROLL_ROLE_ID || !PAYMENT_LINK) {
  throw new Error(
    "Missing env vars: DISCORD_TOKEN, GUILD_ID, ACCESS_ROLE_IDS, PAYROLL_ROLE_ID, PAYMENT_LINK"
  );
}

// ------------------------------------------------------------
// ROLE MODEL (IMPORTANT)
// - PAYROLL_ROLE_ID (g1) is ONLY for Payroll to toggle.
// - Gate roles are g2–g5 (anonymous access buckets).
// - The bot will NEVER assign PAYROLL_ROLE_ID.
// ------------------------------------------------------------
const ALL_ACCESS_ROLE_IDS = ACCESS_ROLE_IDS.split(",").map(s => s.trim()).filter(Boolean);

// Gate roles are ALL_ACCESS_ROLE_IDS EXCEPT the Payroll role (g1)
const GATE_ROLE_IDS = ALL_ACCESS_ROLE_IDS; // already g2–g5


// Safety checks
if (ALL_ACCESS_ROLE_IDS.length < 2) {
  throw new Error("ACCESS_ROLE_IDS must include at least 2 gate role IDs (ex: g2,g3,g4,g5).");
}


const TRIAL_MS = parseFloat(TRIAL_HOURS) * 60 * 60 * 1000;
const MIN_AGE_MS = parseInt(MIN_ACCOUNT_AGE_DAYS, 10) * 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for joins + role changes
  ],
  partials: [Partials.Channel],
});

const now = () => Date.now();

// ---------- DB helpers ----------
function getUser(userId) {
  return db.prepare(`SELECT * FROM users WHERE discord_user_id=?`).get(userId);
}

function upsertJoin(userId) {
  db.prepare(`
    INSERT INTO users (discord_user_id, last_join_at)
    VALUES (?, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET last_join_at=excluded.last_join_at
  `).run(userId, now());
}

function startTrial(userId, expiresAt, gateRoleId) {
  db.prepare(`
    INSERT INTO users (discord_user_id, trial_used, trial_expires_at, gate_role_id, paid, last_join_at)
    VALUES (?, 1, ?, ?, 0, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET
      trial_used=1,
      trial_expires_at=excluded.trial_expires_at,
      gate_role_id=excluded.gate_role_id,
      paid=0,
      last_join_at=excluded.last_join_at
  `).run(userId, expiresAt, gateRoleId, now());
}

function clearTrial(userId) {
  db.prepare(`UPDATE users SET trial_expires_at=NULL, gate_role_id=NULL WHERE discord_user_id=?`).run(userId);
}

function setPaid(userId, paid) {
  db.prepare(`
    INSERT INTO users (discord_user_id, paid, last_join_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET paid=excluded.paid, last_join_at=excluded.last_join_at
  `).run(userId, paid ? 1 : 0, now());
}

function getExpiredTrials() {
  return db
    .prepare(`SELECT discord_user_id, gate_role_id FROM users WHERE trial_expires_at IS NOT NULL AND trial_expires_at <= ?`)
    .all(now());
}

// ---------- Role helpers (ONLY gate roles g2–g5) ----------
function pickRandomGateRoleId() {
  return GATE_ROLE_IDS[Math.floor(Math.random() * GATE_ROLE_IDS.length)];
}

function memberGateRoles(member) {
  return GATE_ROLE_IDS.filter(id => member.roles.cache.has(id));
}

async function fetchRole(guild, roleId) {
  return guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
}

async function enforceSingleGateRole(member, reason) {
  const desired = pickRandomGateRoleId();
  const desiredRole = await fetchRole(member.guild, desired);
  if (!desiredRole) return;

  if (!member.roles.cache.has(desired)) {
    await member.roles.add(desiredRole, reason).catch(() => null);
  }

  const current = memberGateRoles(member);
  for (const id of current) {
    if (id !== desired) {
      const r = await fetchRole(member.guild, id);
      if (r) await member.roles.remove(r, reason).catch(() => null);
    }
  }
}

async function removeAllGateRoles(member, reason) {
  const current = memberGateRoles(member);
  for (const id of current) {
    const r = await fetchRole(member.guild, id);
    if (r) await member.roles.remove(r, reason).catch(() => null);
  }
}

// ---------- DM helpers ----------
async function safeDM(user, content) {
  try {
    await user.send({ content });
  } catch {
    // ignore (DMs closed)
  }
}

function questionsFooter() {
  return [
    `❓ **Questions?**`,
    `Message us on Telegram: https://t.me/splitthepicks`,
  ].join("\n");
}

function welcomeDM(userId) {
  return [
    `Hey <@${userId}> 👋`,
    `Welcome to **SplitThePicks** 😈`,
    ``,
    `I just unlocked **2 days of VIP access** for you.`,
    ``,
    `Here’s how the server works 👇`,
    ``,
    `📈 **VIP Cappers (Elite)**`,
    `• Picks from elite, well-known cappers`,
    `• **KingCap, FiveStar, LaFormula, YDC, ISW, AFSports, Travy, Vonn5, Cesar** + more`,
    `• Delivered instantly when they drop`,
    ``,
    `🔐 **Player Props**`,
    `• Player props from top premiums`,
    `• **snewj, professorpicks, securedtys, officialpicks** & more`,
    `• Mirrored directly from their VIP servers`,
    ``,
    `🎁 **Free Cappers**`,
    `• Access smaller & mid-tier sports handicappers`,
    `• Higher volume, mixed performance`,
    ``,
    `⏳ You’ve got **48 hours** to review the VIP cappers and decide.`,
    ``,
    `👉 Open the server here: https://discord.gg/q7EXxXbJx5`,
    ``,
    `I’ll send the upgrade link when your trial ends.`,
    questionsFooter(),
  ].join("\n");
}

function expiredDM(userId) {
  return [
    `Hey <@${userId}> — your **VIP trial just ended** ⏳`,
    ``,
    `VIP access is now locked.`,
    `You’ll still see free content, but VIP is where the **elite handicappers** are.`,
    ``,
    `⚡ Their picks are **mirrored in real time** and posted instantly in Discord once you’re VIP again.`,
    ``,
    `🔓 Re-activate VIP here:`,
    `👉 ${PAYMENT_LINK}`,
    ``,
    `Access restores automatically after checkout 🔐`,
    questionsFooter(),
  ].join("\n");
}

function noTrialDM(userId) {
  return [
    `Hey <@${userId}> 👋`,
    ``,
    `You’ve already used the **free VIP trial** on this account.`,
    ``,
    `📈 VIP includes picks from **elite sports-betting handicappers**`,
    `⚡ Their picks are **mirrored in real time** and posted instantly inside Discord.`,
    ``,
    `🔓 Unlock VIP here:`,
    `👉 ${PAYMENT_LINK}`,
    ``,
    `Instant access after checkout 🔐`,
    questionsFooter(),
  ].join("\n");
}

function postPurchaseDM(userId) {
  return [
    `Hey <@${userId}> 👋`,
    ``,
    `Your **VIP access to SplitThePicks** is now active 😈`,
    ``,
    `You’re unlocked into:`,
    `💎 **Premium picks from elite cappers**`,
    `📈 Straight bets, parlays and player props included`,
    `⏱️ Picks posted as soon as they drop`,
    ``,
    `⏳ If you don’t see VIP picks immediately, give Discord **1–2 minutes** to sync roles.`,
    ``,
    questionsFooter(),
  ].join("\n");
}

// ---------- Join flow ----------
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  upsertJoin(member.user.id);

  // If they already have Payroll role (g1), treat as paid immediately.
  // NOTE: The bot still assigns a gate role (g2–g5) for anonymity buckets.
  if (member.roles.cache.has(PAYROLL_ROLE_ID)) {
    setPaid(member.user.id, true);
    clearTrial(member.user.id);
    await enforceSingleGateRole(member, "Join: payroll role present, enforce gate role").catch(() => null);
    return;
  }

  // If they already have any gate role (rare), do nothing
  if (memberGateRoles(member).length > 0) return;

  // Account age gate (optional)
if (MIN_AGE_MS > 0) {
  const age = now() - member.user.createdTimestamp;
  if (age < MIN_AGE_MS) {
    await safeDM(
      member.user,
      [
        `Hey <@${member.user.id}> 👋`,
        ``,
        `Quick security check — your Discord account is too new to receive a free VIP trial.`,
        ``,
        `🎁 **Good news:** You can still access the **Free Cappers** section inside the server right now.`,
        `It includes a wide range of smaller & mid-tier handicappers.`,
        ``,
        `🔓 If you want instant access to our **elite-performing VIP cappers**, you can upgrade here:`,
        `${PAYMENT_LINK}`,
        ``,
        `Once you checkout, access is restored automatically.`,
      ].join("\n")
    );
    return;
  }
}


  const row = getUser(member.user.id);

  // One-time trial (assign ONLY gate roles g2–g5)
  if (!row || row.trial_used === 0) {
    const gateRoleId = pickRandomGateRoleId();
    const role = await fetchRole(member.guild, gateRoleId);
    if (!role) return;

    const expiresAt = now() + TRIAL_MS;
    startTrial(member.user.id, expiresAt, gateRoleId);

    await member.roles.add(role, "Trial: granting gate role (g2–g5)").catch(() => null);
    await safeDM(member.user, welcomeDM(member.user.id));
  } else {
    await safeDM(member.user, noTrialDM(member.user.id));
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;

  const hadPayroll = oldMember.roles.cache.has(PAYROLL_ROLE_ID); // g1
  const hasPayroll = newMember.roles.cache.has(PAYROLL_ROLE_ID);

  // 🔓 USER JUST SUBSCRIBED (Payroll added g1)
  if (!hadPayroll && hasPayroll) {
    setPaid(newMember.user.id, true);

    // clear any trial expiry so it never removes access
    clearTrial(newMember.user.id);

    // ensure exactly one gate role (g2–g5)
    await enforceSingleGateRole(newMember, "Payroll role added: enforce gate role").catch(() => null);

    // send post-purchase confirmation DM
    await safeDM(newMember.user, postPurchaseDM(newMember.user.id));
  }

  // 🔒 USER LOST ACCESS (subscription expired / canceled / revoked)
  if (hadPayroll && !hasPayroll) {
    setPaid(newMember.user.id, false);

    // remove all gate roles (g2–g5)
    await removeAllGateRoles(newMember, "Payroll role removed: revoke access").catch(() => null);
  }
});

// ---------- Expiry sweep (edge-case protected) ----------
async function runExpirySweep() {
  const guild = await client.guilds.fetch(GUILD_ID);

  const expired = getExpiredTrials();
  for (const row of expired) {
    // clear expiry first to avoid loops
    db.prepare(`UPDATE users SET trial_expires_at=NULL WHERE discord_user_id=?`).run(row.discord_user_id);

    const member = await guild.members.fetch(row.discord_user_id).catch(() => null);
    if (!member) continue;

    // EDGE CASE: if Payroll role exists, treat as paid and DO NOT remove access
    if (member.roles.cache.has(PAYROLL_ROLE_ID)) {
      setPaid(row.discord_user_id, true);
      clearTrial(row.discord_user_id);
      await enforceSingleGateRole(member, "Expiry sweep: payroll role present, protect access").catch(() => null);
      continue;
    }

    const fresh = getUser(row.discord_user_id);
    if (fresh?.paid === 1) continue;

    // Remove the recorded trial gate role if it exists
    if (row.gate_role_id && member.roles.cache.has(row.gate_role_id)) {
      const r = await fetchRole(guild, row.gate_role_id);
      if (r) await member.roles.remove(r, "Trial expired").catch(() => null);
    }

    // Safety cleanup: remove any other gate roles too
    await removeAllGateRoles(member, "Trial expired: cleanup").catch(() => null);

    // Clear gate_role_id
    db.prepare(`UPDATE users SET gate_role_id=NULL WHERE discord_user_id=?`).run(row.discord_user_id);

    await safeDM(member.user, expiredDM(row.discord_user_id));
  }
}

// ---------- Ready ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await runExpirySweep();
  setInterval(runExpirySweep, 60 * 1000);
});

client.login(DISCORD_TOKEN);

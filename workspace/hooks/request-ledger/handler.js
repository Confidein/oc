import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOOK_KEY = "request-ledger";
const DEFAULT_LOG_FILE = "request-ledger.jsonl";
const pendingBySession = new Map();

function resolveStateDir() {
	const override = process.env.OPENCLAW_STATE_DIR?.trim();
	if (override) return override.replace(/^~(?=$|[\\/])/, os.homedir());
	return path.join(os.homedir(), ".openclaw");
}

function expandHome(input) {
	const trimmed = (input ?? "").trim();
	if (!trimmed) return trimmed;
	return trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
}

function parseAgentSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw.startsWith("agent:")) return null;
	const parts = raw.split(":").filter(Boolean);
	if (parts.length < 3) return null;
	return {
		agentId: parts[1],
		rest: parts.slice(2).join(":")
	};
}

function deriveChannel(sessionKey, context = {}) {
	if (typeof context.provider === "string" && context.provider.trim()) {
		return context.provider.trim();
	}
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return "unknown";
	const head = parsed.rest.split(":")[0] ?? "unknown";
	return head;
}

function deriveTrigger(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return "unknown";
	if (parsed.rest.startsWith("cron:")) return "cron";
	if (parsed.rest.startsWith("feishu:")) return "feishu";
	if (parsed.rest === "main") return "main";
	return parsed.rest.split(":")[0] ?? "unknown";
}

function normalizeUserText(...candidates) {
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

function deriveTopic(text) {
	let topic = text.trim();
	topic = topic.replace(/^\[cron:[^\]]+\]\s*/i, "");
	topic = topic.replace(/^@\S+\s+/g, "");
	topic = topic.replace(/\s+/g, " ");
	const firstLine = topic.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
	if (!firstLine) return "empty-request";
	if (firstLine.length <= 80) return firstLine;
	return `${firstLine.slice(0, 77)}...`;
}

function resolveSessionId(sessionKey, sessionsIndex) {
	const entry = sessionsIndex?.[sessionKey];
	if (entry && typeof entry.sessionId === "string" && entry.sessionId.trim()) {
		return entry.sessionId.trim();
	}
	const match = sessionKey.match(/:run:([0-9a-f-]{36})$/i);
	return match?.[1] ?? null;
}

async function loadSessionsIndex(agentId) {
	const sessionsPath = path.join(
		resolveStateDir(),
		"agents",
		agentId,
		"sessions",
		"sessions.json"
	);
	try {
		return JSON.parse(await fs.readFile(sessionsPath, "utf-8"));
	} catch {
		return {};
	}
}

function extractRunStatsFromTrajectoryLine(row) {
	if (!row || typeof row !== "object") return null;
	if (row.type !== "trace.artifacts" && row.type !== "model.completed") return null;
	const provider = typeof row.provider === "string" ? row.provider : null;
	const modelId = typeof row.modelId === "string" ? row.modelId : null;
	const usage = row.data?.usage && typeof row.data.usage === "object" ? row.data.usage : null;
	return {
		usage,
		provider,
		modelId,
		model: provider && modelId ? `${provider}/${modelId}` : modelId,
		status:
			typeof row.data?.finalStatus === "string"
				? row.data.finalStatus
				: row.type === "model.completed"
					? "completed"
					: null,
		finalPromptText:
			typeof row.data?.finalPromptText === "string" ? row.data.finalPromptText : null
	};
}

async function readLatestRunStats(agentId, sessionId) {
	const trajectoryPath = path.join(
		resolveStateDir(),
		"agents",
		agentId,
		"sessions",
		`${sessionId}.trajectory.jsonl`
	);
	let content;
	try {
		content = await fs.readFile(trajectoryPath, "utf-8");
	} catch {
		return null;
	}
	const lines = content.trim().split("\n").filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const stats = extractRunStatsFromTrajectoryLine(JSON.parse(lines[index]));
			if (stats) return stats;
		} catch {
			// ignore malformed lines
		}
	}
	return null;
}

async function readLatestRunStatsWithRetry(agentId, sessionId) {
	const delays = [0, 150, 400];
	for (const delayMs of delays) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		const stats = await readLatestRunStats(agentId, sessionId);
		if (stats?.usage || stats?.model) return stats;
	}
	return null;
}

async function resolveLogPath() {
	const fallback = path.join(resolveStateDir(), "logs", DEFAULT_LOG_FILE);
	try {
		const cfgPath = path.join(resolveStateDir(), "openclaw.json");
		const cfg = JSON.parse(await fs.readFile(cfgPath, "utf-8"));
		const entry = cfg?.hooks?.internal?.entries?.[HOOK_KEY];
		if (typeof entry?.logPath === "string" && entry.logPath.trim()) {
			return expandHome(entry.logPath);
		}
	} catch {
		// use fallback
	}
	return fallback;
}

async function appendLedgerRecord(record) {
	const logPath = await resolveLogPath();
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf-8");
}

function enqueuePending(sessionKey, pending) {
	const queue = pendingBySession.get(sessionKey) ?? [];
	queue.push(pending);
	pendingBySession.set(sessionKey, queue);
}

function dequeuePending(sessionKey) {
	const queue = pendingBySession.get(sessionKey) ?? [];
	if (queue.length === 0) return null;
	const pending = queue.shift();
	if (queue.length === 0) pendingBySession.delete(sessionKey);
	else pendingBySession.set(sessionKey, queue);
	return pending;
}

async function handlePreprocessed(event) {
	const context = event.context ?? {};
	const userText = normalizeUserText(context.bodyForAgent, context.body, context.content);
	if (!userText) return;

	enqueuePending(event.sessionKey, {
		receivedAt: event.timestamp?.toISOString?.() ?? new Date().toISOString(),
		sessionKey: event.sessionKey,
		channel: deriveChannel(event.sessionKey, context),
		trigger: deriveTrigger(event.sessionKey),
		senderId: context.senderId ?? context.from ?? null,
		senderName: context.senderName ?? null,
		messageId: context.messageId ?? null,
		conversationId: context.conversationId ?? null,
		userText,
		topic: deriveTopic(userText),
		userPreview: userText.length <= 200 ? userText : `${userText.slice(0, 197)}...`
	});
}

async function handleSent(event) {
	const pending = dequeuePending(event.sessionKey);
	if (!pending) return;

	const context = event.context ?? {};
	const parsed = parseAgentSessionKey(event.sessionKey);
	const agentId = parsed?.agentId ?? "main";
	const sessionsIndex = await loadSessionsIndex(agentId);
	const sessionId = resolveSessionId(event.sessionKey, sessionsIndex);
	const runStats = sessionId
		? await readLatestRunStatsWithRetry(agentId, sessionId)
		: null;
	const completedAt = event.timestamp?.toISOString?.() ?? new Date().toISOString();
	const receivedAtMs = Date.parse(pending.receivedAt);
	const completedAtMs = Date.parse(completedAt);
	const elapsedMs =
		Number.isFinite(receivedAtMs) && Number.isFinite(completedAtMs)
			? Math.max(0, completedAtMs - receivedAtMs)
			: null;

	await appendLedgerRecord({
		timestamp: completedAt,
		receivedAt: pending.receivedAt,
		elapsedMs,
		sessionKey: event.sessionKey,
		sessionId,
		agentId,
		channel: pending.channel,
		trigger: pending.trigger,
		senderId: pending.senderId,
		senderName: pending.senderName,
		messageId: pending.messageId,
		conversationId: pending.conversationId,
		topic: pending.topic,
		userPreview: pending.userPreview,
		model: runStats?.model ?? null,
		provider: runStats?.provider ?? null,
		modelId: runStats?.modelId ?? null,
		usage: runStats?.usage ?? null,
		runStatus: runStats?.status ?? null,
		replySuccess: context.success !== false,
		replyError: typeof context.error === "string" ? context.error : null
	});
}

const requestLedger = async (event) => {
	try {
		if (event.type === "message" && event.action === "preprocessed") {
			await handlePreprocessed(event);
			return;
		}
		if (event.type === "message" && event.action === "sent") {
			await handleSent(event);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[request-ledger] ${message}`);
	}
};

export default requestLedger;

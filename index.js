'use strict';

const fs = require('fs');
const path = require('path');

const COMMANDS_FILE = path.join(__dirname, 'commands.json');
const GEARSETS_FILE = path.join(__dirname, 'gearsets.json');
const DUNGEONS_FILE = path.join(__dirname, 'dungeons.json');
const QUESTS_FILE = path.join(__dirname, 'quests.json');
const PAGE_FILE = path.join(__dirname, 'ui', 'index.html');

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return fallback;
	}
}

function normalize(cmd) {
	return String(cmd).trim().replace(/\s+/g, ' ').replace(/^\/@?/, '').trim();
}

let lastLoc = null;        // last known player position {x,y,z}
let zonesCache = null;     // [{ id, channelType, name, huntingZones }]
let zonesError = null;     // last zone-query failure reason
let zonesTried = 0;       // query attempts (for the log line)
let debug = false;         // !qa-debug packet capture toggle
let logging = false;       // !qa-log system-message toggle
let autoActions = {};      // command -> { enabled, seconds }  (auto-revive etc.)
let autoTimer = null;      // pending auto-action timer
let questIndex = null;     // { lines, loose, counts }
let questError = null;     // why the quest index is unusable (shown in the panel)
let questTried = 0;        // build attempts, for the log line

module.exports = function QaQol(mod) {
	let gameState = null;
	try {
		gameState = mod.require['tera-game-state'];
	} catch (e) {
		mod.log(`qa-qol: tera-game-state unavailable: ${e.message}`);
	}

	const ui = mod.require['UI'];

	const me = () => (gameState && gameState.me) || null;
	const inGame = () => { const m = me(); return !!(m && m.gameId); };

	const captureLoc = event => {
		if (event && event.loc && typeof event.loc.x === 'number') {
			lastLoc = { x: event.loc.x, y: event.loc.y, z: event.loc.z };
		}
	};
	[4, 5].forEach(version => {
		try { mod.hook('C_PLAYER_LOCATION', version, captureLoc); } catch (e) { }
	});

	// --- Zone names, straight from the client's live DataCenter ----------------
	// Verified against the client's extracted DataCenter (S1Data/DataCenter_Final_EUR):
	//   /ContinentData/Continent           -> id, channelType, 1..22 <HuntingZone id=.. />
	//   /StrSheet_ZoneName/String@id=<hz>  -> open-world area names ("Island of Dawn")
	//   /StrSheet_Dungeon/String@id=<cont> -> dungeon names ("Sky Cruiser Endeavor")
	//   /StrSheet_Region/String@id=<cont>  -> channeling-zone names ("Cardovek Remnants")
	//   /StrSheet_BattleField/String@id=<c> -> battleground names ("Coliseum")
	// The two string sheets are tiny (187/184/31/11 entries); the continent read
	// needs children enabled to expose its HuntingZone ids.

	function loadZones() {
		if (zonesCache || !mod.queryData) return;
		zonesTried++;

		Promise.all([
			mod.queryData('/ContinentData/Continent/', [], true, true).catch(() => null),
			mod.queryData('/StrSheet_ZoneName/String/', [], true, false).catch(() => null),
			mod.queryData('/StrSheet_Dungeon/String/', [], true, false).catch(() => null),
			mod.queryData('/StrSheet_Region/String/', [], true, false).catch(() => null),
			mod.queryData('/StrSheet_BattleField/String/', [], true, false).catch(() => null)
		]).then(res => {
			const continents = res[0];
			if (!continents || !continents.length) {
				zonesError = 'continent query returned nothing';
				mod.log(`qa-qol: zone names unavailable (try ${zonesTried}): ${zonesError}`);
				return;
			}

			const areaNames = {};
			(res[1] || []).forEach(r => { const a = r && r.attributes; if (a && a.id != null) areaNames[a.id] = a.string; });
			const dungeonNames = {};
			(res[2] || []).forEach(r => { const a = r && r.attributes; if (a && a.id != null) dungeonNames[a.id] = a.string; });
			const regionNames = {};
			(res[3] || []).forEach(r => { const a = r && r.attributes; if (a && a.id != null) regionNames[a.id] = a.string; });
			const battleFieldNames = {};
			(res[4] || []).forEach(r => { const a = r && r.attributes; if (a && a.id != null) battleFieldNames[a.id] = a.string; });

			zonesCache = continents.map(node => {
				const a = node.attributes || {};
				const id = parseInt(a.id, 10);
				if (isNaN(id)) return null;

				// Every Continent child is a HuntingZone (verified: no other child tags).
				const hz = [];
				(node.children || []).forEach(ch => {
					const c = ch && ch.attributes;
					if (c && c.id != null) {
						const v = parseInt(c.id, 10);
						if (!isNaN(v)) hz.push(v);
					}
				});

				const out = { id: id, channelType: a.channelType || 'none', huntingZones: hz };
				// Which sheet holds the name depends on the continent's type.
				let name = null;
				if (a.channelType === 'dungeon') name = dungeonNames[id];
				else if (a.channelType === 'channelingZone') name = regionNames[id] || (hz.length ? areaNames[hz[0]] : null);
				else if (a.channelType === 'battleField') name = regionNames[id] || battleFieldNames[id];
				else name = (hz.length ? areaNames[hz[0]] : null) || regionNames[id] || battleFieldNames[id];
				if (name) out.name = String(name).replace(/^\s+|\s+$/g, '');
				return out;
			}).filter(z => z);

			const named = zonesCache.filter(z => z.name).length;
			mod.log(`qa-qol: ${zonesCache.length} zones indexed, ${named} named (try ${zonesTried})`);
		}).catch(e => {
			zonesError = (e && e.message) || String(e);
			mod.log(`qa-qol: zone query failed (try ${zonesTried}): ${zonesError}`);
		});
	}
	loadZones();
	if (mod.clientInterface) {
		try { mod.clientInterface.once('ready', loadZones); } catch (e) { loadZones(); }
	}
	// The client interface may not be ready when the mod loads; retry once later.
	setTimeout(loadZones, 5000);

	// --- Quest index ---------------------------------------------------------
	// /Quest/Quest/ CANNOT be queried. The client's dcquery path format is
	// /<file>/<childElement>/, which works for /ContinentData/Continent/ because
	// <Continent> elements are children of the root <ContinentData>. Every
	// Quest-*.xml instead has <Quest> as the ROOT element itself, so there are no
	// child <Quest> nodes and findAll returns []. That was the whole bug.
	//
	// So the ids come from quests.json (generated by tools/build-quests.js from
	// this client's own DataCenter), and quest NAMES are refreshed at runtime from
	// /StrSheet_Quest/String/ - the same path shape as /StrSheet_Dungeon/String/,
	// which is known to resolve. A quest's name string has id = questId*1000 + 1.
	function buildQuestIndex(data, liveNames) {
		const names = {};
		const add = map => {
			if (!map) return;
			Object.keys(map).forEach(k => {
				const id = parseInt(k, 10);
				const name = map[k];
				if (!isNaN(id) && id > 0 && name) names[id] = String(name).replace(/^\s+|\s+$/g, '');
			});
		};
		add(data && data.questNames);
		add(liveNames);

		const quests = {};
		Object.keys(names).forEach(k => { quests[k] = { id: parseInt(k, 10), name: names[k] }; });

		const used = {};
		const lines = [];
		((data && data.lines) || []).forEach(l => {
			if (!l) return;
			const list = [];
			(l.quests || []).forEach(q => {
				if (quests[q]) { list.push(quests[q]); used[q] = 1; }
			});
			lines.push({ id: l.id != null ? l.id : null, name: l.name || ('Line ' + l.id), quests: list });
		});

		// Several lines legitimately share a name (9x "Avatar Weapons"); suffix the
		// repeats with their id so they stay distinguishable.
		const counts = {};
		lines.forEach(l => { counts[l.name] = (counts[l.name] || 0) + 1; });
		lines.forEach(l => { if (counts[l.name] > 1) l.name += ' #' + l.id; });

		const loose = [];
		Object.keys(quests).forEach(k => { if (!used[k]) loose.push(quests[k]); });
		loose.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));

		const inLine = Object.keys(used).length;
		return {
			lines: lines,
			loose: loose,
			counts: { quests: inLine + loose.length, lines: lines.length, inLine: inLine, loose: loose.length }
		};
	}

	function loadQuests() {
		if (questIndex || !mod.queryData) return;
		questTried++;

		const data = readJson(QUESTS_FILE, null);
		if (!data || !data.questNames || !Object.keys(data.questNames).length) {
			questError = 'quests.json missing or empty - run tools/build-quests.js';
			mod.log(`qa-qol: ${questError}`);
			return;
		}

		// Build immediately from the baked data so the panel always works, then
		// upgrade the names from the live client if that query resolves.
		questIndex = buildQuestIndex(data, null);
		questError = null;
		mod.log(`qa-qol: ${questIndex.counts.quests} quests, ${questIndex.counts.lines} lines indexed (try ${questTried})`);

		mod.queryData('/StrSheet_Quest/String/', [], true, false).then(strings => {
			if (!strings || !strings.length) return;
			const live = {};
			strings.forEach(r => {
				const a = r && r.attributes;
				if (!a || a.id == null) return;
				const sid = parseInt(a.id, 10);
				if (isNaN(sid) || sid % 1000 !== 1) return;
				const qid = Math.floor(sid / 1000);
				if (qid > 0 && a.string) live[qid] = a.string;
			});
			const liveCount = Object.keys(live).length;
			if (!liveCount) return;
			questIndex = buildQuestIndex(data, live);
			mod.log(`qa-qol: quest names refreshed from client (${liveCount} names)`);
		}).catch(() => { /* baked names already loaded; nothing to report */ });
	}
	loadQuests();

	// --- Page + data (data files are re-read on every request, so they can be
	// --- edited while the mod is running; just reopen/reload the menu) --------
	ui.get('/', (req, res) => { res.sendFile(PAGE_FILE); });
	ui.get('/commands', (req, res) => { res.json(readJson(COMMANDS_FILE, { sections: [], actions: [] })); });
	ui.get('/gearsets', (req, res) => { res.json(readJson(GEARSETS_FILE, { filters: [], sets: [] })); });
	ui.get('/dungeons', (req, res) => { res.json(readJson(DUNGEONS_FILE, { dungeons: [] })); });
	ui.get('/quests', (req, res) => {
		res.json({
			index: questIndex || { lines: [], loose: [], counts: { quests: 0, lines: 0 } },
			error: questError,
			loading: !questIndex
		});
	});

	// --- Live game state (no QA command needed) ------------------------------
	ui.get('/state', (req, res) => {
		const m = me();
		res.json({
			inGame: inGame(),
			char: (m && m.name) || null,
			level: (m && m.level) || null,
			zone: (m && m.zone) || null,
			inDungeon: !!(m && m.inDungeon),
			loc: lastLoc,
			auto: autoActions
		});
	});

	// --- Auto actions (fire a command N seconds after death) -----------------
	// S_SHOW_DEAD_UI is the server->client packet sent when the player dies and
	// the death UI appears. When an auto action is enabled we send its command
	// that many seconds later (auto revive, etc).
	ui.get('/auto', (req, res) => {
		const cmd = normalize(req.query.cmd || '');
		if (!cmd || cmd.length > 200) return res.json({ ok: false, error: 'Bad command' });

		let a = autoActions[cmd];
		if (!a) a = autoActions[cmd] = { enabled: false, seconds: 5 };

		if (req.query.enabled !== undefined)
			a.enabled = req.query.enabled === '1' || req.query.enabled === 'true';
		if (req.query.seconds !== undefined) {
			const n = parseInt(req.query.seconds, 10);
			if (!isNaN(n) && n >= 0 && n <= 600) a.seconds = n;
		}

		res.json({ ok: true, action: { command: cmd, enabled: a.enabled, seconds: a.seconds } });
	});

	try {
		mod.hook('S_SHOW_DEAD_UI', 1, () => {
			const cmd = Object.keys(autoActions).filter(k => autoActions[k].enabled)[0];
			if (!cmd || !inGame()) return;

			const seconds = autoActions[cmd].seconds;
			if (autoTimer) mod.clearTimeout(autoTimer);
			mod.log(`death detected -> "${cmd}" in ${seconds}s`);

			autoTimer = mod.setTimeout(() => {
				autoTimer = null;
				if (!inGame()) return;
				mod.send('C_ADMIN', 1, { command: cmd });
				mod.log(`auto: sent "${cmd}"`);
			}, seconds * 1000);
		});
	} catch (e) {
		mod.log(`qa-qol: cannot hook S_SHOW_DEAD_UI (${e.message})`);
	}

	// --- Item name lookup (terastable item table, with the sheet key as backup)
	ui.get('/names', (req, res) => {
		const ids = String(req.query.ids || '').split(',').map(s => parseInt(s, 10)).filter(v => !isNaN(v));
		const out = {};
		const key = readJson(path.join(__dirname, 'key.json'), {});
		ids.forEach(id => { if (key[id]) out[id] = key[id]; });

		const items = (gameState && gameState.data && gameState.data.items);
		if (items) {
			ids.forEach(id => {
				const item = items.get(id);
				if (item && item.name) out[id] = item.name;
			});
		}
		res.json(out);
	});

	// --- Item name search ----------------------------------------------------
	ui.get('/items', (req, res) => {
		const q = String(req.query.q || '').toLowerCase();
		if (q.length < 2) return res.json([]);

		const items = (gameState && gameState.data && gameState.data.items) || new Map();
		const out = [];
		items.forEach((item, id) => {
			const name = item && item.name;
			if (name && name.toLowerCase().indexOf(q) !== -1) {
				out.push({ id: id, name: name });
				if (out.length >= 50) return;
			}
		});
		res.json(out);
	});

	// --- Zone list for the teleport panel ------------------------------------
	ui.get('/zones', (req, res) => {
		res.json({
			zones: zonesCache || [],
			error: zonesError,
			count: zonesCache ? zonesCache.length : 0
		});
	});

	// --- Run a single QA command --------------------------------------------
	ui.get('/run', (req, res) => {
		if (typeof req.query.cmd !== 'string')
			return res.json({ ok: false, error: 'Invalid command' });

		const command = normalize(req.query.cmd);
		if (!command || command.length > 500)
			return res.json({ ok: false, error: 'Empty or too long command' });

		if (!inGame())
			return res.json({ ok: false, error: 'Not in game' });

		mod.send('C_ADMIN', 1, { command });
		mod.log(`Sent: ${command}`);
		res.json({ ok: true, sent: command });
	});

	// --- Multi-command actions (e.g. "Reset all cheats") ---------------------
	ui.get('/action', (req, res) => {
		if (!inGame()) return res.json({ ok: false, error: 'Not in game' });

		const actions = readJson(COMMANDS_FILE, {}).actions || [];
		let act = null;
		for (let i = 0; i < actions.length; i++) {
			if (actions[i].id === req.query.id) act = actions[i];
		}
		if (!act || !act.cmds) return res.json({ ok: false, error: 'Unknown action' });

		const sent = [];
		act.cmds.forEach(c => {
			const command = normalize(c);
			if (command && command.length <= 500) {
				mod.send('C_ADMIN', 1, { command });
				sent.push(command);
			}
		});
		mod.log(`Action "${act.id}": ${sent.join('; ')}`);
		res.json({ ok: true, sent: sent });
	});

	// --- Name the current zone so it shows up in the dungeon list ------------
	ui.get('/dungeons/add', (req, res) => {
		const name = String(req.query.name || '').trim();
		const m = me();
		if (!name || name.length > 60) return res.json({ ok: false, error: 'Bad name' });
		if (!m || !m.zone) return res.json({ ok: false, error: 'No current zone' });

		const data = readJson(DUNGEONS_FILE, { dungeons: [] });
		const list = (Array.isArray(data.dungeons) ? data.dungeons : [])
			.filter(d => d && d.contId !== m.zone);
		list.push({ name: name, contId: m.zone });
		list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
		data.dungeons = list;

		try {
			fs.writeFileSync(DUNGEONS_FILE, JSON.stringify(data, null, 2) + '\n');
		} catch (e) {
			return res.json({ ok: false, error: String(e) });
		}
		res.json({ ok: true, dungeons: list });
	});

	// --- Chat commands -------------------------------------------------------
	mod.command.add('qa', () => { ui.open(); });

	// Optional: log every system message the server sends, which is how you see
	// the reply to a QA command ("skills cleared", "unknown command", ...).
	mod.command.add('qa-log', () => {
		logging = !logging;
		mod.log(`qa-qol system message log: ${logging ? 'ON' : 'OFF'}`);
	});
	try { mod.hook('S_SYSTEM_MESSAGE', 1, event => { if (logging) mod.log(`[sysmsg] ${event.message}`); }); }
	catch (e) { mod.log(`qa-qol: cannot hook S_SYSTEM_MESSAGE (${e.message})`); }

	// Ground-truth capture (off by default): !qa-debug logs what the REAL client
	// sends for command-ish packets, so command formats can be verified in-game.
	mod.command.add('qa-debug', () => {
		debug = !debug;
		mod.log(`qa-qol debug capture: ${debug ? 'ON - now type a QA command in chat' : 'OFF'}`);
	});
	['C_ADMIN', 'C_OP_COMMAND', 'C_SLASH_COMMAND'].forEach(name => {
		try {
			mod.hook(name, 1, event => {
				if (debug) mod.log(`${name} => ${JSON.stringify(event)}`);
			});
		} catch (e) {
			mod.log(`qa-qol: cannot hook ${name} (no def?): ${e.message}`);
		}
	});

};

module.exports.saveState = () => ({
	zonesCache: zonesCache,
	zonesError: zonesError,
	lastLoc: lastLoc,
	debug: debug,
	logging: logging,
	autoActions: autoActions,
	questIndex: questIndex
});

module.exports.loadState = state => {
	if (!state) return;
	if (state.zonesCache) zonesCache = state.zonesCache;
	if (state.zonesError !== undefined) zonesError = state.zonesError || null;
	if (state.lastLoc) lastLoc = state.lastLoc;
	if (state.autoActions) autoActions = state.autoActions;
	if (state.questIndex) { questIndex = state.questIndex; questError = null; }
	debug = !!state.debug;
	logging = !!state.logging;
};

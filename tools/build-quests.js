// Generates quests.json for the mod: quest lines (id -> member quest ids) and
// quest names, both read from the client's extracted DataCenter.
//
'use strict';

const fs = require('fs');
const path = require('path');

//replace with path to extracted datacenter
const DC = 'F:/Games/OstoDev/S1Game/S1Data/DataCenter_Final_EUR.387463';
const OUT = 'F:/Games/OstoDev/toolbox/mods/qa-qol/quests.json';

function readDir(folder) {
	const dir = path.join(DC, folder);
	return fs.readdirSync(dir).filter(f => f.endsWith('.xml'))
		.map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
}

// --- quest names from StrSheet_Quest (the runtime-queryable source) ----------
const names = {};
for (const text of readDir('StrSheet_Quest')) {
	const re = /<String id="(\d+)" string="([^"]*)"/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const id = parseInt(m[1], 10);
		if (id % 1000 !== 1) continue;
		const questId = Math.floor(id / 1000);
		// id 0 is junk ("Accept" is string id 1); empty names (e.g. 4795001) are
		// placeholder strings for quests that were never shipped - skip both.
		if (questId < 1) continue;
		const name = m[2].replace(/^\s+|\s+$/g, '');
		if (!name) continue;
		names[questId] = name;
	}
}

// --- quest lines from QuestGroupList ---------------------------------------
const groupText = readDir('QuestGroupList').join('\n');
const lines = [];
const gr = /<StoryGroup\b([^>]*)>([\s\S]*?)<\/StoryGroup>/g;
let g;
while ((g = gr.exec(groupText)) !== null) {
	const idM = /\bid="(\d+)"/.exec(g[1]);
	const nameM = /\bname="([^"]*)"/.exec(g[1]);
	const quests = [];
	const qr = /<Quest id="(\d+)"/g;
	let c;
	while ((c = qr.exec(g[2])) !== null) quests.push(parseInt(c[1], 10));
	lines.push({
		id: idM ? parseInt(idM[1], 10) : null,
		name: nameM ? nameM[1] : ('Line ' + (idM ? idM[1] : '?')),
		quests: quests.filter(q => names[q])
	});
}

// Quests that belong to no line.
const inLine = new Set();
lines.forEach(l => l.quests.forEach(q => inLine.add(q)));
const loose = Object.keys(names).map(Number).filter(q => !inLine.has(q)).sort((a, b) => a - b);

// De-duplicate line names (9 lines are all called "Avatar Weapons") so they stay
// distinguishable in the menu.
const nameCount = {};
lines.forEach(l => { nameCount[l.name] = (nameCount[l.name] || 0) + 1; });
lines.forEach(l => { if (nameCount[l.name] > 1) l.name += ' #' + l.id; });

const payload = {
	lines: lines,
	questNames: names,
	counts: {
		quests: Object.keys(names).length,
		lines: lines.length,
		inLine: inLine.size,
		loose: loose.length
	}
};

fs.writeFileSync(OUT, JSON.stringify(payload) + '\n');

// --- verification against ground truth -------------------------------------
const shipped = new Set();
for (const f of fs.readdirSync(path.join(DC, 'Quest')).filter(f => /^Quest-\d+\.xml$/.test(f))) {
	const m = /\bid="(\d+)"/.exec(fs.readFileSync(path.join(DC, 'Quest', f), 'utf8').slice(0, 400));
	if (m) shipped.add(parseInt(m[1], 10));
}
const matched = [...Object.keys(names).map(Number)].filter(q => shipped.has(q)).length;
const memberships = lines.reduce((a, l) => a + l.quests.length, 0);
const dropped = [...shipped].filter(q => !names[q]);

console.log(`wrote ${OUT}`);
console.log(`  quests ${payload.counts.quests}   lines ${payload.counts.lines}   inLine ${inLine.size}   loose ${loose.length}`);
console.log(`  line memberships ${memberships} (all resolvable: ${lines.every(l => l.quests.every(q => names[q]))})`);
console.log(`  shipped quests ${shipped.size}, matched by name ${matched} (${(100 * matched / shipped.size).toFixed(1)}%)`);
console.log(`  shipped but unnamed (omitted): ${dropped.join(', ')}`);
console.log(`  payload ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`\nsample lines:`);
lines.slice(0, 5).forEach(l => console.log(`   ${l.name} (${l.quests.length}): ${l.quests.slice(0, 2).map(q => names[q] + ' ' + q).join(', ')}`));
const argon = lines.find(l => /^Argon War/.test(l.name));
console.log(`   ${argon.name} (${argon.quests.length}): ${argon.quests.slice(0, 4).map(q => names[q] + ' ' + q).join(', ')}`);
console.log('\nloose sample:', loose.slice(0, 5).map(q => `${names[q]} ${q}`).join(' | '));
console.log(`\nduplicate-name lines: ${lines.filter(l => / #\d+$/.test(l.name)).length}`);
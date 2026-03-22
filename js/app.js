// =============================================================
// CONFIGURATION
// =============================================================
const ESPN_API_DIRECT = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const ESPN_API_PROXY = '/api/espn';
const REFRESH_MS = 60_000;
const STORAGE = {
    groups:   'golfSweep_groups',
    entries:  'golfSweep_entries',
    bonus:    'golfSweep_bonus',
    settings: 'golfSweep_settings',
};
const STATE_API = '/api/state';
const STORAGE_BACKUP_SUFFIX = '_backup';
const CUT_STATUS_MARKERS = ['CUT', 'MISSED CUT', 'MDF', 'MC', 'WD', 'DQ'];

// Outright winner odds for the 2026 Valspar Championship (American format).
// Lower number = shorter odds = more favoured. Used to rank players into groups.
const ODDS_DATA = {
    "Xander Schauffele":1100,"Viktor Hovland":1600,"Matt Fitzpatrick":1800,
    "Akshay Bhatia":2250,"Justin Thomas":2300,"Jordan Spieth":2300,
    "Jacob Bridgeman":2350,"Patrick Cantlay":2350,"Ben Griffin":2500,
    "Brooks Koepka":2800,"J.J. Spaun":3000,"Corey Conners":3300,
    "Nicolai Højgaard":3500,"Keegan Bradley":3600,"Sahith Theegala":3700,
    "Nick Taylor":4000,"Taylor Pendrith":4200,"Ryo Hisatsune":4600,
    "Rasmus Højgaard":4800,"Davis Thompson":5000,"Wyndham Clark":5200,
    "Alex Smalley":5500,"Aaron Rai":5800,"Ricky Castillo":6100,
    "Matt McCarty":6100,"Thorbjørn Olesen":6200,"Pierceson Coody":6300,
    "Max Homa":6500,"Christiaan Bezuidenhout":6800,
    "Taylor Moore":7000,"Austin Smotherman":7000,"Patrick Rodgers":7000,
    "Kristoffer Reitan":7500,"Max McGreevy":7600,"Mac Meissner":7600,
    "Bud Cauley":8400,"Stephan Jaeger":8400,
    "Rasmus Neergaard-Petersen":8600,"Jordan Smith":9000,"John Parry":9400,
    "Tony Finau":9400,"Marco Penge":9600,"Sungjae Im":9600,
    "Mackenzie Hughes":10000,"Denny McCarthy":10000,"Rico Hoey":10000,
    "Matti Schmid":10500,"Matt Wallace":10500,
    "Johnny Keefer":11000,"Tom Kim":11000,"Kevin Roy":11000,
    "Lee Hodges":11500,"Lucas Glover":11500,"Blades Brown":11500,
    "Dan Brown":12000,"Jesper Svensson":12000,"Doug Ghim":12000,
    "Matt Kuchar":12500,"David Ford":12500,"Billy Horschel":12500,
    "Michael Kim":12500,"Andrew Novak":13000,"Eric Cole":13000,
    "Michael Brennan":13000,"Garrick Higgo":14000,
    "Adrien Dumont de Chassart":14000,"Beau Hossler":14000,
    "Vince Whaley":14000,"Austin Eckroat":14500,"Chad Ramey":14500,
    "Luke Clanton":14500,"Gary Woodland":16000,"Steven Fisk":16000,
    "Chandler Blanchet":16500,"Adam Hadwin":17000,"Kevin Yu":17500,
    "Zecheng Dou":18000,"S.H. Kim":18500,"Webb Simpson":21000,
    "Zac Blair":22000,"Adrien Saddier":22500,"Mark Hubbard":23000,
    "Zach Bauchou":24000,"David Lipsky":25000,"Emiliano Grillo":25000,
    "Andrew Putnam":26000,"Dylan Wu":28000,"Matthieu Pavon":29000,
    "Adam Svensson":30000,"Isaiah Salinda":31000,"Neal Shipley":31000,
    "Takumi Kanaya":32000,"Karl Vilips":32500,"Patrick Fishburn":33000,
    "John VanDerLaan":33000,"Chandler Phillips":34000,"Davis Riley":35000,
    "A.J. Ewart":35000,"Jackson Suber":37500,"Jeremy Paul":41000,
    "Brandt Snedeker":44000,"Hank Lebioda":45000,"Jimmy Stanger":47000,
    "Patton Kizzire":48000,"Joe Highsmith":49000,"Pontus Nyholm":52500,
    "Kevin Streelman":55000,"Brice Garnett":57500,"David Skinns":60000,
    "Erik van Rooyen":60000,"Adam Schenk":62500,"Peter Malnati":65000,
    "Davis Chatfield":67500,"Nick Dunlap":70000,"Paul Peterson":70000,
    "Brian Campbell":75000,"Gordon Sargent":75000,"Cam Davis":80000,
    "Kensei Hirata":92500,"Danny Walker":95000,"Charley Hoffman":110000,
    "Jeffrey Kang":130000,"Paul Waring":140000,"Alejandro Tosti":150000,
    "Rafael Campos":180000,"Danny Willett":200000,"Marcelo Rozo":325000,
    "Greg Koch":500000,
};

// =============================================================
// APPLICATION STATE
// =============================================================
let espnData       = null;   // raw ESPN response
let playerMap      = {};     // playerId -> { id, name, flag, flagAlt, score, linescores, status, order }
let groups         = { 1: [], 2: [], 3: [], 4: [], 5: [] };
let entries        = [];     // [{ id, entrant, team, picks:[id x5], bonusAnswers:[] }]
let bonusQuestions = [];     // [{ question, correctAnswer }]
let activeTab      = 'sweep';
let adminMode      = false;
let refreshTimer   = null;

function useServerStorage() {
    return window.location.protocol !== 'file:';
}

// =============================================================
// LOCAL STORAGE HELPERS
// =============================================================
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateGroups(data) {
    if (!isObject(data)) return false;
    for (let g = 1; g <= 5; g++) {
        const key = g.toString();
        if (!Array.isArray(data[key])) return false;
        if (!data[key].every(id => typeof id === 'string')) return false;
    }
    return true;
}

function validateEntries(data) {
    if (!Array.isArray(data)) return false;
    return data.every(en =>
        isObject(en) &&
        typeof en.id === 'string' &&
        typeof en.entrant === 'string' &&
        typeof en.team === 'string' &&
        Array.isArray(en.picks) &&
        en.picks.length === 5 &&
        en.picks.every(p => typeof p === 'string') &&
        (!en.bonusAnswers || Array.isArray(en.bonusAnswers))
    );
}

function validateBonusQuestions(data) {
    if (!Array.isArray(data)) return false;
    return data.every(q =>
        isObject(q) &&
        typeof q.question === 'string' &&
        typeof (q.correctAnswer || '') === 'string'
    );
}

function normalizeEntries(data) {
    return data.map(en => ({
        id: en.id,
        entrant: en.entrant.trim(),
        team: en.team.trim(),
        picks: en.picks.slice(0, 5),
        bonusAnswers: Array.isArray(en.bonusAnswers) ? en.bonusAnswers.map(a => `${a || ''}`) : [],
        createdAt: en.createdAt || Date.now(),
    }));
}

function save(key, data) {
    try {
        const payload = JSON.stringify(data);
        localStorage.setItem(key, payload);
        localStorage.setItem(`${key}${STORAGE_BACKUP_SUFFIX}`, payload);
    } catch (e) {
        console.error(`Storage save failed for ${key}:`, e);
    }
}

function load(key, fallback, opts = {}) {
    const { validate = () => true, normalize = x => x } = opts;
    try {
        const raw = localStorage.getItem(key);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (validate(parsed)) return normalize(parsed);
            console.warn(`Storage validation failed for ${key}, trying backup.`);
        }
    } catch (e) {
        console.warn(`Storage parse failed for ${key}, trying backup.`, e);
    }

    try {
        const backupRaw = localStorage.getItem(`${key}${STORAGE_BACKUP_SUFFIX}`);
        if (backupRaw) {
            const parsedBackup = JSON.parse(backupRaw);
            if (validate(parsedBackup)) {
                localStorage.setItem(key, backupRaw);
                return normalize(parsedBackup);
            }
        }
    } catch (e) {
        console.warn(`Backup parse failed for ${key}.`, e);
    }

    return fallback;
}
function loadState() {
    groups = load(
        STORAGE.groups,
        { 1: [], 2: [], 3: [], 4: [], 5: [] },
        { validate: validateGroups }
    );
    entries = load(
        STORAGE.entries,
        [],
        { validate: validateEntries, normalize: normalizeEntries }
    );
    bonusQuestions = load(
        STORAGE.bonus,
        [],
        { validate: validateBonusQuestions }
    );
}

async function loadStateFromServer() {
    const response = await fetch(STATE_API, { cache: 'no-store' });
    if (!response.ok) throw new Error(`State load failed (${response.status})`);
    const payload = await response.json();

    if (validateGroups(payload.groups)) {
        groups = payload.groups;
        save(STORAGE.groups, groups);
    }
    if (validateEntries(payload.entries)) {
        entries = normalizeEntries(payload.entries);
        save(STORAGE.entries, entries);
    }
    if (validateBonusQuestions(payload.bonus)) {
        bonusQuestions = payload.bonus;
        save(STORAGE.bonus, bonusQuestions);
    }
}

async function persistStateToServer(partial) {
    if (!useServerStorage()) return;
    try {
        const response = await fetch(STATE_API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(partial),
        });
        if (!response.ok) {
            console.warn('State save failed:', response.status);
        }
    } catch (error) {
        console.warn('State save failed:', error);
    }
}

async function loadInitialState() {
    groups = load(
        STORAGE.groups,
        { 1: [], 2: [], 3: [], 4: [], 5: [] },
        { validate: validateGroups }
    );
    entries = load(
        STORAGE.entries,
        [],
        { validate: validateEntries, normalize: normalizeEntries }
    );
    bonusQuestions = load(
        STORAGE.bonus,
        [],
        { validate: validateBonusQuestions }
    );
    if (useServerStorage()) {
        await loadStateFromServer();
    }
}
function saveGroups() {
    save(STORAGE.groups, groups);
    void persistStateToServer({ groups });
}
function saveEntries() {
    save(STORAGE.entries, entries);
    void persistStateToServer({ entries });
}
function saveBonus() {
    save(STORAGE.bonus, bonusQuestions);
    void persistStateToServer({ bonus: bonusQuestions });
}

// =============================================================
// ESPN DATA
// =============================================================
async function fetchESPN() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    try {
        const r = await fetch(getEspnApiUrl());
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        espnData = await r.json();
        buildPlayerMap();

        // Auto-populate groups on first load when they're empty
        const totalAssigned = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
        if (totalAssigned === 0 && Object.keys(playerMap).length > 0) {
            autoAssignGroups(true);
        }

        renderAll();
        const now = new Date().toLocaleTimeString();
        document.getElementById('lastUpdated').textContent = now;
        document.getElementById('footerUpdated').textContent = now;
    } catch (e) {
        console.error('ESPN fetch failed:', e);
    } finally {
        btn.classList.remove('spinning');
    }
}

function getEspnApiUrl() {
    if (window.location.protocol === 'file:') {
        return ESPN_API_DIRECT;
    }
    return ESPN_API_PROXY;
}

function buildPlayerMap() {
    playerMap = {};
    const comp = getCompetition();
    if (!comp) return;
    (comp.competitors || []).forEach(c => {
        const a = c.athlete || {};
        const name = a.displayName || a.fullName || 'Unknown';
        playerMap[c.id] = {
            id:         c.id,
            name,
            shortName:  a.shortName || '',
            flag:       a.flag?.href || '',
            flagAlt:    a.flag?.alt || '',
            score:      c.score ?? 'E',
            linescores: c.linescores || [],
            order:      c.order || 999,
            status:     c.status || {},
            sortOrder:  c.sortOrder ?? c.order ?? 999,
            odds:       matchOdds(name),
        };
    });
}

function matchOdds(espnName) {
    // Direct match first
    if (ODDS_DATA[espnName] !== undefined) return ODDS_DATA[espnName];

    // Normalise: lowercase, strip accents/diacritics, trim
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const target = norm(espnName);

    for (const [oddsName, odds] of Object.entries(ODDS_DATA)) {
        if (norm(oddsName) === target) return odds;
    }

    // Last-name match as fallback (handles "Dan Brown" vs "Daniel Brown", etc.)
    const lastName = target.split(/\s+/).pop();
    for (const [oddsName, odds] of Object.entries(ODDS_DATA)) {
        if (norm(oddsName).split(/\s+/).pop() === lastName) return odds;
    }

    // No match — assign very long odds so they land in Group 5
    return 999999;
}

function getEvent()       { return espnData?.events?.[0]; }
function getCompetition() { return getEvent()?.competitions?.[0]; }
function getTournamentState() { return getCompetition()?.status?.type?.state || 'pre'; }
function getCompletedRounds() {
    // Estimate completed rounds from linescores that have values
    const comp = getCompetition();
    if (!comp) return 0;
    const first = (comp.competitors || [])[0];
    if (!first) return 0;
    let rounds = 0;
    (first.linescores || []).forEach(ls => {
        if (ls.value !== undefined || ls.displayValue) rounds++;
    });
    // If tournament is still in progress and not everyone has finished the current round,
    // count only fully-completed rounds by checking if most players have a score for that round
    return rounds;
}

// =============================================================
// TAB NAVIGATION
// =============================================================
function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add('active');
    renderCurrentTab();
}

function renderCurrentTab() {
    switch (activeTab) {
        case 'sweep':  renderSweepLeaderboard(); break;
        case 'enter':  renderEntryForm(); renderEntriesList(); break;
        case 'groups': renderGroups(); break;
        case 'rules':  renderBonusDisplay(); break;
        case 'golf':   renderGolfLeaderboard(); break;
    }
}

function renderAll() {
    renderBanner();
    renderCurrentTab();
}

// =============================================================
// TOURNAMENT BANNER
// =============================================================
function renderBanner() {
    const el = document.getElementById('tournamentBanner');
    const ev = getEvent();
    if (!ev) { el.innerHTML = '<span class="banner-loading">No active tournament</span>'; return; }
    const comp = getCompetition();
    const st = comp?.status?.type;
    const state = st?.state || 'pre';
    const detail = st?.shortDetail || st?.detail || st?.description || '';
    const players = comp?.competitors?.length || 0;
    el.innerHTML = `
        <strong>${ev.name || 'Golf Tournament'}</strong>
        <span class="banner-sep">|</span>
        ${formatDateRange(new Date(ev.date), new Date(ev.endDate))}
        <span class="banner-sep">|</span>
        ${players} players
        <span class="status-badge ${state}">${detail}</span>
    `;
}

function formatDateRange(s, e) {
    const o = { month: 'short', day: 'numeric' };
    return `${s.toLocaleDateString('en-US', o)} \u2013 ${e.toLocaleDateString('en-US', { ...o, year: 'numeric' })}`;
}

// =============================================================
// GOLF LEADERBOARD (raw ESPN)
// =============================================================
function renderGolfLeaderboard() {
    const tbody = document.getElementById('golfBody');
    const comp = getCompetition();
    const players = comp?.competitors || [];
    const state = getTournamentState();

    if (!players.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">Loading...</td></tr>'; return; }

    const enriched = players.map(c => ({ c, isCut: isPlayerCut(c.id) }));
    const activePlayers = enriched.filter(p => !p.isCut);
    const cutPlayers = enriched.filter(p => p.isCut);

    activePlayers.sort((a, b) =>
        state === 'pre' ? ((a.c.order || 0) - (b.c.order || 0)) : (parseScore(a.c.score) - parseScore(b.c.score))
    );
    cutPlayers.sort((a, b) => (a.c.order || 0) - (b.c.order || 0));

    const renderRow = (competitor, posDisplay, cutRow) => {
        const a = competitor.athlete || {};
        const sc = competitor.score ?? '--';
        const ls = competitor.linescores || [];
        const roundScores = [0, 1, 2, 3].map(j => formatRoundStrokes(ls[j]?.value));
        const today = cutRow ? '-' : getTodayDisplay(ls);
        const strokesTotal = cutRow ? '--' : formatStrokeTotal(ls);
        const thru = cutRow ? 'CUT' : (competitor.status?.thru != null ? (competitor.status.thru === 18 ? 'F' : competitor.status.thru) : '--');

        return `<tr data-player="${(a.displayName || '').toLowerCase()}" class="${cutRow ? 'cut-player-row' : ''}">
            <td class="col-pos">${posDisplay}</td>
            <td><div class="player-cell">
                ${a.flag?.href ? `<img class="player-flag" src="${a.flag.href}" alt="${a.flag?.alt || ''}">` : ''}
                <span class="player-name">${a.displayName || 'Unknown'}</span>
            </div></td>
            <td class="col-score ${cutRow ? 'score-cut' : scoreClass(sc)}">${cutRow ? 'CUT' : fmtScore(sc, state)}</td>
            <td class="col-today">${today}</td>
            <td class="col-r">${roundScores[0]}</td><td class="col-r">${roundScores[1]}</td>
            <td class="col-r">${roundScores[2]}</td><td class="col-r">${roundScores[3]}</td>
            <td class="col-strokes">${strokesTotal}</td>
            <td class="col-thru">${thru}</td>
        </tr>`;
    };

    let pos = 1;
    let lastSc = null;
    const activeRows = activePlayers.map((row, i) => {
        const numSc = parseScore(row.c.score);
        if (state !== 'pre') {
            if (numSc !== lastSc) {
                pos = i + 1;
                lastSc = numSc;
            }
        } else {
            pos = i + 1;
        }
        const hasTieNext = state !== 'pre' && activePlayers[i + 1] && parseScore(activePlayers[i + 1].c.score) === numSc;
        const hasTiePrev = state !== 'pre' && i > 0 && parseScore(activePlayers[i - 1].c.score) === numSc;
        const posDisplay = (hasTieNext || hasTiePrev) ? `T${pos}` : `${pos}`;
        return renderRow(row.c, posDisplay, false);
    });

    const cutRows = cutPlayers.map(row => renderRow(row.c, '-', true));
    if (cutRows.length) {
        activeRows.push(
            `<tr class="cut-divider"><td colspan="10">The following players failed to make the cut</td></tr>`
        );
        activeRows.push(...cutRows);
    }

    tbody.innerHTML = activeRows.join('');
    document.getElementById('playerCount').textContent = `${players.length} players`;
}

// =============================================================
// PLAYER GROUPS
// =============================================================
function renderGroups() {
    const grid = document.getElementById('groupsGrid');
    let html = '';
    for (let g = 1; g <= 5; g++) {
        const ids = groups[g] || [];
        html += `<div class="group-col g${g}">
            <div class="group-col-header">Group ${g} <span class="count">${ids.length} players</span></div>
            <div class="group-player-list">${ids.map((id, i) => {
                const p = playerMap[id];
                const name = p ? p.name : `ID: ${id}`;
                const odds = p && p.odds < 999999 ? `+${p.odds}` : '';
                return `<div class="group-player">
                    <span class="gp-num">${i + 1}</span>
                    <span class="gp-name">${name}</span>
                    ${odds ? `<span class="gp-odds">${odds}</span>` : ''}
                    <button class="gp-remove" onclick="removeFromGroup('${id}', ${g})" title="Remove">&times;</button>
                </div>`;
            }).join('')}</div>
        </div>`;
    }
    grid.innerHTML = html;

    if (adminMode) renderUnassigned();
}

function renderUnassigned() {
    const assigned = new Set();
    for (let g = 1; g <= 5; g++) (groups[g] || []).forEach(id => assigned.add(id));
    const unassigned = Object.values(playerMap)
        .filter(p => !assigned.has(p.id))
        .sort((a, b) => a.order - b.order);

    document.getElementById('unassignedCount').textContent = unassigned.length;
    const list = document.getElementById('unassignedList');
    const q = (document.getElementById('unassignedSearch')?.value || '').toLowerCase();

    list.innerHTML = unassigned
        .filter(p => !q || p.name.toLowerCase().includes(q))
        .map(p => `<div class="unassigned-player">
            ${p.flag ? `<img class="up-flag" src="${p.flag}" alt="${p.flagAlt}">` : ''}
            <span class="up-name">${p.name}</span>
            <select onchange="assignToGroup('${p.id}', this.value); this.value=''">
                <option value="">Grp</option>
                <option value="1">G1</option><option value="2">G2</option>
                <option value="3">G3</option><option value="4">G4</option><option value="5">G5</option>
            </select>
        </div>`).join('');
}

function assignToGroup(playerId, groupNum) {
    const g = parseInt(groupNum);
    if (!g || g < 1 || g > 5) return;
    // Remove from any current group first
    for (let i = 1; i <= 5; i++) groups[i] = (groups[i] || []).filter(id => id !== playerId);
    groups[g].push(playerId);
    saveGroups();
    renderGroups();
}

function removeFromGroup(playerId, groupNum) {
    groups[groupNum] = (groups[groupNum] || []).filter(id => id !== playerId);
    saveGroups();
    renderGroups();
}

function autoAssignGroups(silent) {
    if (!silent && !confirm('This will replace all current groups with an auto-assignment based on betting odds. Continue?')) return;

    // Sort every player by odds (shortest first = most favoured)
    const allPlayers = Object.values(playerMap).sort((a, b) => a.odds - b.odds);
    const n = allPlayers.length;

    // Ascending group sizes: G1 smallest, G5 largest
    // Ratios  ~8% / 13% / 19% / 27% / 33%  (each group larger than the previous)
    const sizes = [
        Math.round(n * 0.08),
        Math.round(n * 0.13),
        Math.round(n * 0.19),
        Math.round(n * 0.27),
    ];
    sizes.push(n - sizes[0] - sizes[1] - sizes[2] - sizes[3]);

    groups = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    let idx = 0;
    for (let g = 1; g <= 5; g++) {
        const end = idx + sizes[g - 1];
        for (; idx < end && idx < n; idx++) groups[g].push(allPlayers[idx].id);
    }

    saveGroups();
    renderGroups();
    renderEntryForm();
}

function clearAllGroups() {
    if (!confirm('Clear all group assignments?')) return;
    groups = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    saveGroups();
    renderGroups();
}

// =============================================================
// ENTRY FORM
// =============================================================
function renderEntryForm() {
    for (let g = 1; g <= 5; g++) {
        const sel = document.getElementById(`pickGroup${g}`);
        if (!sel) continue;
        const current = sel.value;
        sel.innerHTML = '<option value="">-- Select --</option>';
        (groups[g] || []).forEach(id => {
            const p = playerMap[id];
            if (!p) return;
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = p.name;
            sel.appendChild(opt);
        });
        if (current) sel.value = current;
    }

    // Bonus questions in form
    const bqDiv = document.getElementById('bonusQuestionsForm');
    if (bonusQuestions.length === 0) {
        bqDiv.innerHTML = '';
        return;
    }
    bqDiv.innerHTML = bonusQuestions.map((bq, i) => `
        <div class="form-row">
            <label for="bonusA${i}">Bonus Q${i + 1}: ${bq.question}</label>
            <input type="text" id="bonusA${i}" placeholder="Your answer">
        </div>
    `).join('');
}

function submitTeam(e) {
    e.preventDefault();
    const entrant = document.getElementById('entrantName').value.trim();
    const team    = document.getElementById('teamName').value.trim();
    const picks   = [];
    for (let g = 1; g <= 5; g++) {
        const v = document.getElementById(`pickGroup${g}`).value;
        if (!v) { alert(`Please select a player from Group ${g}`); return; }
        picks.push(v);
    }
    const bonusAnswers = bonusQuestions.map((_, i) =>
        (document.getElementById(`bonusA${i}`)?.value || '').trim()
    );

    entries.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        entrant,
        team,
        picks,
        bonusAnswers,
        createdAt: Date.now(),
    });
    saveEntries();
    document.getElementById('teamForm').reset();
    renderEntriesList();
    renderSweepLeaderboard();
    alert(`Team "${team}" submitted!`);
}

function deleteEntry(id) {
    if (!confirm('Delete this entry?')) return;
    entries = entries.filter(e => e.id !== id);
    saveEntries();
    renderEntriesList();
    renderSweepLeaderboard();
}

function renderEntriesList() {
    const el = document.getElementById('entriesList');
    document.getElementById('teamCount').textContent = entries.length;
    if (!entries.length) { el.innerHTML = '<p style="color:var(--gray-400);font-size:13px;padding:12px">No teams entered yet.</p>'; return; }
    el.innerHTML = entries.map(en => {
        const pickNames = en.picks.map(id => playerMap[id]?.name || id).join(', ');
        return `<div class="entry-card">
            <div>
                <div class="ec-name">${en.team}</div>
                <div class="ec-team">${en.entrant}</div>
                <div class="ec-picks">${pickNames}</div>
            </div>
            <button class="ec-delete" onclick="deleteEntry('${en.id}')" title="Delete">&times;</button>
        </div>`;
    }).join('');
}

// =============================================================
// BONUS QUESTIONS
// =============================================================
function renderBonusDisplay() {
    const el = document.getElementById('bonusQuestionsDisplay');
    if (!bonusQuestions.length) {
        el.innerHTML = '<p style="padding:16px;color:var(--gray-400);font-size:13px">No bonus questions set. Admin can add them.</p>';
        return;
    }
    el.innerHTML = bonusQuestions.map((bq, i) => `
        <div class="bonus-q-item">
            <span class="bq-num">Q${i + 1}:</span> ${bq.question}
            ${bq.correctAnswer ? `<div class="bq-answer">Answer: <strong>${bq.correctAnswer}</strong></div>` : ''}
        </div>
    `).join('');
}

function openBonusModal() {
    const body = document.getElementById('bonusModalBody');
    const qs = bonusQuestions.length ? bonusQuestions : [
        { question: '', correctAnswer: '' },
        { question: '', correctAnswer: '' },
        { question: '', correctAnswer: '' },
    ];
    body.innerHTML = qs.map((q, i) => `
        <div class="form-row">
            <label>Question ${i + 1}</label>
            <input type="text" id="bqEdit${i}" value="${q.question}" placeholder="e.g. What will be the best score in R1?">
        </div>
        <div class="form-row">
            <label>Correct Answer (leave blank until known)</label>
            <input type="text" id="bqAns${i}" value="${q.correctAnswer || ''}" placeholder="Answer">
        </div>
    `).join('<hr style="border:none;border-top:1px solid var(--gray-200);margin:8px 0">');
    document.getElementById('bonusModal').classList.add('open');
}

function saveBonusQuestions() {
    bonusQuestions = [];
    for (let i = 0; i < 3; i++) {
        const q = (document.getElementById(`bqEdit${i}`)?.value || '').trim();
        const a = (document.getElementById(`bqAns${i}`)?.value || '').trim();
        if (q) bonusQuestions.push({ question: q, correctAnswer: a });
    }
    saveBonus();
    document.getElementById('bonusModal').classList.remove('open');
    renderBonusDisplay();
    renderEntryForm();
}

// =============================================================
// SCORING ENGINE
// =============================================================

function getPlayerScoreNum(playerId) {
    // Returns the player's score vs par as a number, or null if unavailable
    const p = playerMap[playerId];
    if (!p) return null;
    return parseScore(p.score);
}

function isPlayerCut(playerId) {
    const p = playerMap[playerId];
    if (!p) return false;
    if (hasCutMarker(p.score)) return true;
    if (hasCutMarker(p.status?.thru)) return true;
    const statusTexts = getStatusTextCandidates(p.status);
    if (statusTexts.some(hasCutMarker)) return true;
    return inferCutFromRounds(p);
}

function getPlayerThru(playerId) {
    const p = playerMap[playerId];
    if (!p) return '--';
    if (isPlayerCut(playerId)) return 'CUT';
    const thru = p.status?.thru;
    if (thru === 18) return 'F';
    if (thru != null) return thru;
    return '--';
}

function getPlayerRoundScore(playerId, roundIdx) {
    const p = playerMap[playerId];
    if (!p) return null;
    const ls = p.linescores?.[roundIdx];
    if (!ls) return null;
    return ls.displayValue || ls.value || null;
}

function getLeadersAfterRound(roundNum) {
    // roundNum: 1-4 (R1, R2, R3, R4)
    // Returns Set of playerIds who were leading after that round
    const comp = getCompetition();
    if (!comp) return new Set();

    let best = Infinity;
    let leaders = [];

    (comp.competitors || []).forEach(c => {
        const ls = c.linescores || [];
        // Check if this player has completed up to roundNum
        let total = 0;
        let hasAll = true;
        for (let r = 0; r < roundNum; r++) {
            const v = ls[r]?.value;
            if (v == null) { hasAll = false; break; }
            total += v;
        }
        if (!hasAll) return;
        if (total < best) { best = total; leaders = [c.id]; }
        else if (total === best) leaders.push(c.id);
    });
    return new Set(leaders);
}

function getTournamentWinners() {
    // After tournament ends, the winner is the player with the lowest total score
    if (getTournamentState() !== 'post') return new Set();
    const comp = getCompetition();
    if (!comp) return new Set();

    let best = Infinity;
    let winners = [];
    (comp.competitors || []).forEach(c => {
        const sc = parseScore(c.score);
        if (sc < best) { best = sc; winners = [c.id]; }
        else if (sc === best) winners.push(c.id);
    });
    return new Set(winners);
}

function calculateTeamScore(entry) {
    const result = {
        playerScores: [],    // [{ playerId, name, score, thru, isCut, roundScores, isDropped }]
        rawTotal: 0,
        allMadeCut: true,
        cutCount: 0,
        competitionType: 'main', // main | plate | eliminated
        leaderBonuses: 0,    // count of leader-after-round bonuses
        winnerBonus: 0,
        bonusCorrect: 0,
        totalBonus: 0,
        grandTotal: 0,
        hasCutPlayers: false,
        eliminated: false,
    };

    // Gather player scores
    entry.picks.forEach(playerId => {
        const p = playerMap[playerId];
        const sc = getPlayerScoreNum(playerId);
        const cut = isPlayerCut(playerId);
        const thru = getPlayerThru(playerId);
        const rs = [0,1,2,3].map(r => getPlayerRoundScore(playerId, r));

        result.playerScores.push({
            playerId,
            name: p?.name || playerId,
            score: sc ?? 999,
            displayScore: p ? fmtScore(p.score, getTournamentState()) : '--',
            thru,
            isCut: cut,
            roundScores: rs,
        });
        if (cut) { result.allMadeCut = false; result.hasCutPlayers = true; }
    });

    result.cutCount = result.playerScores.filter(p => p.isCut).length;
    result.allMadeCut = result.cutCount === 0;
    result.hasCutPlayers = result.cutCount > 0;

    if (result.cutCount >= 3) {
        result.competitionType = 'eliminated';
        result.eliminated = true;
        result.rawTotal = null;
        result.totalBonus = 0;
        result.grandTotal = null;
        return result;
    }

    if (result.cutCount === 2) {
        result.competitionType = 'plate';
        // In the plate comp, only the three non-cut players count.
        const platePlayers = result.playerScores
            .filter(p => !p.isCut)
            .sort((a, b) => a.score - b.score);
        result.rawTotal = platePlayers.slice(0, 3).reduce((sum, p) => sum + p.score, 0);
    } else {
        result.competitionType = 'main';
        // Main competition remains best 4 from 5.
        const sorted = [...result.playerScores].sort((a, b) => a.score - b.score);
        if (sorted.length === 5) sorted[4].isDropped = true;
        result.rawTotal = sorted.slice(0, 4).reduce((sum, p) => sum + p.score, 0);
    }

    // All-5-made-cut bonus (-3)
    const cutBonus = result.competitionType === 'main' && result.allMadeCut ? -3 : 0;

    // Leader bonuses: check R1, R2, R3
    const pickSet = new Set(entry.picks);
    let leaderCount = 0;
    for (let r = 1; r <= 3; r++) {
        const leaders = getLeadersAfterRound(r);
        for (const pid of pickSet) {
            if (leaders.has(pid)) { leaderCount++; break; }
        }
    }
    result.leaderBonuses = leaderCount;

    // Winner bonus (-2)
    const winners = getTournamentWinners();
    let winnerHit = false;
    for (const pid of pickSet) {
        if (winners.has(pid)) { winnerHit = true; break; }
    }
    result.winnerBonus = winnerHit ? 1 : 0;

    // Bonus question correct answers
    let bCorrect = 0;
    if (bonusQuestions.length > 0) {
        bonusQuestions.forEach((bq, i) => {
            if (!bq.correctAnswer) return;
            const ans = (entry.bonusAnswers?.[i] || '').trim().toLowerCase();
            const correct = bq.correctAnswer.trim().toLowerCase();
            if (ans && ans === correct) bCorrect++;
        });
    }
    result.bonusCorrect = bCorrect;

    result.totalBonus = cutBonus + (-1 * leaderCount) + (winnerHit ? -2 : 0) + (-1 * bCorrect);
    result.grandTotal = result.rawTotal + result.totalBonus;

    return result;
}

// =============================================================
// SWEEPSTAKE LEADERBOARD
// =============================================================
function getSweepTableColSpan() {
    return 19 + bonusQuestions.length + (adminMode ? 1 : 0);
}

function getSweepHeaderHtml() {
    const adminCol = adminMode ? '<th></th>' : '';
    return `<tr>
        <th class="col-pos">Pos</th>
        <th class="col-team" style="text-align:left">Team</th>
        <th class="g1-head col-player-pick">Group 1</th><th class="g1-head col-sc">Sc</th><th class="g1-head col-thru">Thru</th>
        <th class="g2-head col-player-pick">Group 2</th><th class="g2-head col-sc">Sc</th><th class="g2-head col-thru">Thru</th>
        <th class="g3-head col-player-pick">Group 3</th><th class="g3-head col-sc">Sc</th><th class="g3-head col-thru">Thru</th>
        <th class="g4-head col-player-pick">Group 4</th><th class="g4-head col-sc">Sc</th><th class="g4-head col-thru">Thru</th>
        <th class="g5-head col-player-pick">Group 5</th><th class="g5-head col-sc">Sc</th><th class="g5-head col-thru">Thru</th>
        ${bonusQuestions.map((_, i) => `<th class="col-bp">BP${i + 1}</th>`).join('')}
        <th class="col-bp">BP Tot</th>
        <th class="col-total">Total</th>
        ${adminCol}
    </tr>`;
}

function buildGroupCells(entry, result) {
    return entry.picks.map((pid, gi) => {
        const ps = result.playerScores.find(p => p.playerId === pid);
        if (!ps) return `<td class="g${gi + 1}-cell col-player-pick">--</td><td class="g${gi + 1}-cell col-sc">--</td><td class="g${gi + 1}-cell col-thru">--</td>`;

        const dropped = ps.isDropped ? ' dropped-score' : '';
        const cutCls = ps.isCut ? ' player-cut' : '';
        const scCls = ps.isCut ? 'score-cut' : scoreClass(ps.score.toString());

        return `<td class="g${gi + 1}-cell col-player-pick${cutCls}${dropped}">${ps.name}</td>
                <td class="g${gi + 1}-cell col-sc ${scCls}${dropped}">${ps.isCut ? 'CUT' : fmtScoreNum(ps.score)}</td>
                <td class="g${gi + 1}-cell col-thru${dropped}">${ps.thru}</td>`;
    }).join('');
}

function renderCompetitionTable(thead, tbody, scoredRows, emptyMessage, rowClassFn = () => '') {
    thead.innerHTML = getSweepHeaderHtml();

    if (!scoredRows.length) {
        tbody.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">${emptyMessage}</td></tr>`;
        return;
    }

    scoredRows.sort((a, b) => a.result.grandTotal - b.result.grandTotal);

    let pos = 1;
    let lastTotal = null;
    const rows = scoredRows.map((s, idx) => {
        const { entry, result } = s;
        const gt = result.grandTotal;
        if (gt !== lastTotal) { pos = idx + 1; lastTotal = gt; }
        const posStr = scoredRows[idx + 1] && scoredRows[idx + 1].result.grandTotal === gt ? `T${pos}` :
                       idx > 0 && scoredRows[idx - 1].result.grandTotal === gt ? `T${pos}` : `${pos}`;

        const groupCells = buildGroupCells(entry, result);

        const bpCells = bonusQuestions.map((bq, i) => {
            const ans = entry.bonusAnswers?.[i] || '';
            const correct = bq.correctAnswer && ans.trim().toLowerCase() === bq.correctAnswer.trim().toLowerCase();
            return `<td class="col-bp">${correct ? '<span style="color:var(--green-600);font-weight:700">Yes</span>' : (ans || '--')}</td>`;
        }).join('');

        const deleteCol = adminMode ? `<td><button class="delete-btn" onclick="deleteEntry('${entry.id}')">&times;</button></td>` : '';
        const rowClass = rowClassFn(pos, entry, result);
        return `<tr class="${rowClass}">
            <td class="col-pos">${posStr}</td>
            <td class="col-team">${entry.team} <span class="entrant">(${entry.entrant})</span></td>
            ${groupCells}
            ${bpCells}
            <td class="col-bp" style="font-weight:700">${result.totalBonus}</td>
            <td class="col-total ${scoreClass(gt.toString())}">${fmtScoreNum(gt)}</td>
            ${deleteCol}
        </tr>`;
    });

    tbody.innerHTML = rows.join('');
}

function renderEliminatedTeams(eliminatedRows) {
    const headEl = document.getElementById('eliminatedHead');
    const bodyEl = document.getElementById('eliminatedBody');
    const countEl = document.getElementById('eliminatedEntryCount');
    countEl.textContent = `${eliminatedRows.length}`;
    headEl.innerHTML = getSweepHeaderHtml();

    if (!eliminatedRows.length) {
        bodyEl.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">No teams eliminated.</td></tr>`;
        return;
    }

    const rows = [...eliminatedRows]
        .sort((a, b) => b.result.cutCount - a.result.cutCount)
        .map(({ entry, result }) => {
            const groupCells = buildGroupCells(entry, result);
            const bpCells = bonusQuestions.map((bq, i) => {
                const ans = entry.bonusAnswers?.[i] || '';
                const correct = bq.correctAnswer && ans.trim().toLowerCase() === bq.correctAnswer.trim().toLowerCase();
                return `<td class="col-bp">${correct ? '<span style="color:var(--green-600);font-weight:700">Yes</span>' : (ans || '--')}</td>`;
            }).join('');
            const deleteCol = adminMode ? `<td><button class="delete-btn" onclick="deleteEntry('${entry.id}')">&times;</button></td>` : '';

            return `<tr>
                <td class="col-pos">-</td>
                <td class="col-team">${entry.team} <span class="entrant">(${entry.entrant})</span></td>
                ${groupCells}
                ${bpCells}
                <td class="col-bp">${result.cutCount} CUT</td>
                <td class="col-total score-cut">CUT</td>
                ${deleteCol}
            </tr>`;
        });

    bodyEl.innerHTML = rows.join('');
}

function renderSweepLeaderboard() {
    const mainHead = document.getElementById('sweepHead');
    const mainBody = document.getElementById('sweepBody');
    const plateHead = document.getElementById('plateHead');
    const plateBody = document.getElementById('plateBody');

    if (!entries.length || Object.keys(playerMap).length === 0) {
        mainHead.innerHTML = '';
        plateHead.innerHTML = '';
        mainBody.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">No entries yet, or waiting for ESPN data.</td></tr>`;
        plateBody.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">No teams currently in the plate competition.</td></tr>`;
        document.getElementById('sweepEntryCount').textContent = `${entries.length} entries`;
        document.getElementById('plateEntryCount').textContent = '0';
        renderEliminatedTeams([]);
        return;
    }

    const scored = entries.map(en => ({
        entry: en,
        result: calculateTeamScore(en),
    }));

    const mainRows = scored.filter(s => s.result.competitionType === 'main');
    const plateRows = scored.filter(s => s.result.competitionType === 'plate');
    const eliminatedRows = scored.filter(s => s.result.competitionType === 'eliminated');

    renderCompetitionTable(
        mainHead,
        mainBody,
        mainRows,
        'No teams currently in the main competition.',
        (pos) => (pos === 1 ? 'sweep-row-gold' : pos === 2 ? 'sweep-row-silver' : '')
    );

    renderCompetitionTable(
        plateHead,
        plateBody,
        plateRows,
        'No teams currently in the plate competition.',
        () => 'sweep-row-plate'
    );

    renderEliminatedTeams(eliminatedRows);
    document.getElementById('plateEntryCount').textContent = `${plateRows.length}`;
    document.getElementById('sweepEntryCount').textContent = `${entries.length} entries (${mainRows.length} main, ${plateRows.length} plate, ${eliminatedRows.length} eliminated)`;
}

// =============================================================
// SCORE FORMATTING HELPERS
// =============================================================
function parseScore(score) {
    if (score == null || score === '' || score === '--') return 999;
    const s = score.toString().toUpperCase();
    if (s === 'E') return 0;
    if (hasCutMarker(s)) return 999;
    const n = parseInt(s, 10);
    return isNaN(n) ? 999 : n;
}

function scoreClass(score) {
    const n = parseScore(score);
    if (n === 999) return '';
    return n < 0 ? 'score-under' : n > 0 ? 'score-over' : 'score-even';
}

function fmtScore(score, state) {
    if (state === 'pre' && (score === 'E' || score == null)) return 'E';
    if (score == null || score === '--') return '--';
    const s = score.toString().toUpperCase();
    if (s === 'E') return 'E';
    if (hasCutMarker(s)) return s;
    const n = parseInt(s, 10);
    if (isNaN(n)) return s;
    return n > 0 ? `+${n}` : `${n}`;
}

function hasCutMarker(value) {
    if (value == null) return false;
    const text = value.toString().toUpperCase();
    return CUT_STATUS_MARKERS.some(marker => text.includes(marker));
}

function getStatusTextCandidates(status) {
    if (!status) return [];
    const candidates = [];
    if (typeof status === 'string') return [status];

    const add = (value) => {
        if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
    };

    add(status.displayValue);
    add(status.shortDetail);
    add(status.detail);
    add(status.description);
    add(status.state);

    const type = status.type;
    if (type && typeof type === 'object') {
        add(type.displayValue);
        add(type.shortDetail);
        add(type.detail);
        add(type.description);
        add(type.name);
        add(type.state);
    }
    return candidates;
}

function inferCutFromRounds(player) {
    const comp = getCompetition();
    if (!comp || !player) return false;

    const period = Number(comp?.status?.period || 0);
    const detail = (comp?.status?.type?.detail || comp?.status?.type?.shortDetail || '').toUpperCase();

    // ESPN site API often omits explicit "CUT" status. Once round 3 starts/completes,
    // players who missed the cut usually only have 2 rounds of linescores.
    const tournamentPastCut = period >= 3 || detail.includes('ROUND 3') || detail.includes('ROUND 4');
    if (!tournamentPastCut) return false;

    const roundsListed = Array.isArray(player.linescores) ? player.linescores.length : 0;
    return roundsListed < 3;
}

function fmtScoreNum(n) {
    if (n === 0) return 'E';
    return n > 0 ? `+${n}` : `${n}`;
}

function formatRoundStrokes(v) {
    if (v == null || v === '') return '--';
    const n = Number(v);
    if (!Number.isFinite(n)) return `${v}`;
    return `${Math.round(n)}`;
}

function formatStrokeTotal(linescores) {
    const vals = (linescores || []).map(ls => Number(ls?.value)).filter(v => Number.isFinite(v));
    if (!vals.length) return '--';
    const total = vals.reduce((sum, v) => sum + v, 0);
    return `${Math.round(total)}`;
}

function getTodayDisplay(linescores) {
    const rounds = linescores || [];
    for (let i = rounds.length - 1; i >= 0; i--) {
        const d = rounds[i]?.displayValue;
        if (d != null && `${d}`.trim() !== '' && `${d}`.trim() !== '-') return `${d}`;
    }
    return '--';
}

// =============================================================
// PLAYER SEARCH (Golf tab)
// =============================================================
function filterGolfPlayers(query) {
    const q = query.toLowerCase().trim();
    const rows = document.querySelectorAll('#golfBody tr[data-player]');
    let vis = 0;
    rows.forEach(row => {
        const match = !q || (row.dataset.player || '').includes(q);
        row.style.display = match ? '' : 'none';
        if (match) vis++;
    });
    document.getElementById('playerCount').textContent = q ? `${vis} of ${rows.length} players` : `${rows.length} players`;
}

// =============================================================
// ADMIN MODE
// =============================================================
function toggleAdmin() {
    adminMode = !adminMode;
    document.body.classList.toggle('admin-mode', adminMode);
    document.getElementById('adminToggle').classList.toggle('active', adminMode);
    renderCurrentTab();
}

// =============================================================
// AUTO REFRESH
// =============================================================
function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(fetchESPN, REFRESH_MS);
}
function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// =============================================================
// INIT
// =============================================================
document.addEventListener('DOMContentLoaded', async () => {
    await loadInitialState();

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Refresh
    document.getElementById('refreshBtn').addEventListener('click', fetchESPN);
    document.getElementById('autoUpdate').addEventListener('change', e => {
        e.target.checked ? startAutoRefresh() : stopAutoRefresh();
    });

    // Admin
    document.getElementById('adminToggle').addEventListener('click', toggleAdmin);

    // Team form
    document.getElementById('teamForm').addEventListener('submit', submitTeam);

    // Groups admin
    document.getElementById('autoGroupBtn')?.addEventListener('click', autoAssignGroups);
    document.getElementById('clearGroupBtn')?.addEventListener('click', clearAllGroups);
    document.getElementById('unassignedSearch')?.addEventListener('input', () => renderUnassigned());

    // Player search (golf tab)
    document.getElementById('playerSearch')?.addEventListener('input', e => filterGolfPlayers(e.target.value));

    // Bonus questions
    document.getElementById('editBonusBtn')?.addEventListener('click', openBonusModal);
    document.getElementById('saveBonusBtn')?.addEventListener('click', saveBonusQuestions);
    document.getElementById('cancelBonusBtn')?.addEventListener('click', () => {
        document.getElementById('bonusModal').classList.remove('open');
    });

    // Initial fetch
    fetchESPN();
    startAutoRefresh();
});

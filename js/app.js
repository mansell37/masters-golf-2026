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

// Outright winner odds for the 2026 Masters Tournament at Augusta National (American format).
// Rory McIlroy is the defending champion. Odds sourced from FanDuel/DraftKings as of April 7, 2026.
// Lower number = shorter odds = more favoured. Used to rank players into groups.
const ODDS_DATA = {
    "Scottie Scheffler":500,"Jon Rahm":950,"Bryson DeChambeau":1000,
    "Rory McIlroy":1100,"Xander Schauffele":1400,"Ludvig Åberg":1500,
    "Matt Fitzpatrick":2000,"Cameron Young":2000,"Tommy Fleetwood":2200,
    "Collin Morikawa":2500,"Brooks Koepka":3000,"Justin Rose":3000,
    "Robert MacIntyre":3000,"Min Woo Lee":3000,"Hideki Matsuyama":3500,
    "Patrick Reed":4000,"Jordan Spieth":4500,"Viktor Hovland":5500,
    "Patrick Cantlay":5500,"Shane Lowry":5500,"Akshay Bhatia":6000,
    "Justin Thomas":6500,"Tyrrell Hatton":7000,"Sam Burns":8000,
    "Corey Conners":8000,"Marco Penge":8000,"Wyndham Clark":10000,
    "Sahith Theegala":10000,"Harris English":10000,"Cameron Smith":10000,
    "Jason Day":10000,"Maverick McNealy":10000,"Brian Harman":10000,
    "Gary Woodland":10000,"Tony Finau":10000,"Sungjae Im":12000,
    "Max Homa":12000,"Rasmus Højgaard":15000,"Ben Griffin":15000,
    "Kurt Kitayama":15000,"Aaron Rai":15000,"Ryan Fox":15000,
    "Nicolai Højgaard":18000,"Adam Scott":20000,"Sergio Garcia":22000,
    "Fred Couples":50000,"Mike Weir":50000,"Sandy Lyle":100000,
};

// =============================================================
// APPLICATION STATE
// =============================================================
let espnData       = null;   // raw ESPN response
let playerMap      = {};     // playerId -> { id, name, flag, flagAlt, score, linescores, status, order, teeTime }
let groups         = { 1: [], 2: [], 3: [], 4: [], 5: [] };
let entries        = [];     // [{ id, entrant, team, sweep, picks:[id x5], bonusAnswers:[] }]
let bonusQuestions = [];     // [{ question, correctAnswer }]
let activeTab      = 'sweep';
let activeSweep    = 'nab';  // 'nab' | 'bnz' — which sweep is shown on the Sweepstake tab
let activeDetailSweep = 'nab'; // 'nab' | 'bnz' | 'all' — filter on the Detail tab
let adminMode      = false;
let refreshTimer   = null;

// Pre-set bonus questions for the 2026 Masters
const DEFAULT_BONUS_QUESTIONS = [
    { question: 'What will the best Rd1 score be?', correctAnswer: '' },
    { question: 'How many current LIV players will make the cut (10 are playing)?', correctAnswer: '' },
    { question: 'Will there be a hole in one? (Y/N)', correctAnswer: '' },
];

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
        sweep: en.sweep || 'nab',
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

    // Only overwrite local groups if server has a non-empty valid set
    if (validateGroups(payload.groups)) {
        const serverGroupCount = Object.values(payload.groups).reduce((s, a) => s + a.length, 0);
        const localGroupCount  = Object.values(groups).reduce((s, a) => s + a.length, 0);
        if (serverGroupCount > 0 || localGroupCount === 0) {
            groups = payload.groups;
            save(STORAGE.groups, groups);
        }
    }

    // Only overwrite local entries if server has entries, OR local is already empty
    if (validateEntries(payload.entries)) {
        if (payload.entries.length > 0 || entries.length === 0) {
            entries = normalizeEntries(payload.entries);
            save(STORAGE.entries, entries);
        }
    }

    // Only overwrite bonus questions if server has them, OR local is empty
    if (validateBonusQuestions(payload.bonus)) {
        if (payload.bonus.length > 0 || bonusQuestions.length === 0) {
            bonusQuestions = payload.bonus;
            save(STORAGE.bonus, bonusQuestions);
        }
    }

    // Always push local state back to server if server was empty (re-sync after redeploy)
    const serverIsEmpty = (!payload.entries || payload.entries.length === 0) &&
                          (!payload.groups  || Object.values(payload.groups).every(a => a.length === 0));
    if (serverIsEmpty && (entries.length > 0 || Object.values(groups).some(a => a.length > 0))) {
        console.log('Server state was empty — re-syncing local data to server...');
        await persistStateToServer({ groups, entries, bonus: bonusQuestions });
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
    // Pre-populate bonus questions if none exist yet
    if (bonusQuestions.length === 0) {
        bonusQuestions = DEFAULT_BONUS_QUESTIONS.map(q => ({ ...q }));
        saveBonus();
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

        // Auto-populate groups only on very first load when no groups exist
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

function extractTeeTimeFromStats(roundLinescores) {
    // ESPN buries tee time in linescores[0].statistics.categories[0].stats as a date string
    // e.g. "Thu Apr 09 08:26:00 PDT 2026" — but the timezone label is wrong (EDT not PDT)
    try {
        const stats = roundLinescores?.[0]?.statistics?.categories?.[0]?.stats || [];
        for (let i = stats.length - 1; i >= 0; i--) {
            const dv = stats[i]?.displayValue || '';
            if (/\d{4}/.test(dv)) {
                // Replace incorrect PDT label with the actual Augusta timezone (EDT)
                const fixed = dv.replace(/\bPDT\b/, 'EDT').replace(/\bPST\b/, 'EST');
                const dt = new Date(fixed);
                if (!isNaN(dt.getTime())) return dt.toISOString();
            }
        }
    } catch {}
    return null;
}

function buildPlayerMap() {
    playerMap = {};
    const comp = getCompetition();
    if (!comp) return;
    const currentPeriod = Number(comp.status?.period || 1);
    const currentRoundIdx = Math.max(0, currentPeriod - 1);

    (comp.competitors || []).forEach(c => {
        const a = c.athlete || {};
        const name = a.displayName || a.fullName || 'Unknown';
        const roundLinescores = c.linescores || [];

        // THRU: ESPN nests per-hole linescores inside the current round's linescore entry
        const currentRoundData = roundLinescores[currentRoundIdx] || {};
        const holeScores = currentRoundData.linescores || [];
        const thruCount = holeScores.length;

        // Tee time: try obvious fields first, then dig into stats
        const teeTime = c.teeTime || c.status?.teeTime || extractTeeTimeFromStats(roundLinescores);

        playerMap[c.id] = {
            id:         c.id,
            name,
            shortName:  a.shortName || '',
            flag:       a.flag?.href || '',
            flagAlt:    a.flag?.alt || '',
            score:      c.score ?? 'E',
            linescores: roundLinescores,
            thruCount,
            order:      c.order || 999,
            status:     c.status || {},
            sortOrder:  c.sortOrder ?? c.order ?? 999,
            odds:       matchOdds(name),
            teeTime,
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
function isCutMade() {
    // ESPN uses state:'post' to mean "current period is complete" (not whole tournament).
    // Cut is made only after Round 2 is fully done:
    //   - period 3+ means R3 has started → R2 definitely done
    //   - period 2 AND state 'post' means R2 just completed (between rounds)
    const comp = getCompetition();
    if (!comp) return false;
    const period = Number(comp.status?.period || 0);
    const state = getTournamentState();
    if (period >= 3) return true;
    if (period === 2 && state === 'post') return true;
    return false;
}

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
        case 'sweep':     renderSweepLeaderboard(); break;
        case 'enter':     renderEntryForm(); renderEntriesList(); renderBonusAdminPanel(); break;
        case 'groups':    renderGroups(); break;
        case 'rules':     renderBonusDisplay(); break;
        case 'golf':      renderGolfLeaderboard(); break;
        case 'detail':    renderDetailedLeaderboard(); break;
        case 'analytics': renderAnalytics(); break;
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

    const currentPeriod = Number(comp?.status?.period || 1);
    const currentRoundIdx = Math.max(0, currentPeriod - 1);

    const renderRow = (competitor, posDisplay, cutRow) => {
        const a = competitor.athlete || {};
        const sc = competitor.score ?? '--';
        const ls = competitor.linescores || [];
        const roundScores = [0, 1, 2, 3].map(j => formatRoundStrokes(ls[j]?.value));
        const today = cutRow ? '-' : getTodayDisplay(ls);
        const strokesTotal = cutRow ? '--' : formatStrokeTotal(ls);

        // THRU: ESPN nests hole-by-hole linescores inside the current round's linescore
        let thru = '--';
        if (cutRow) {
            thru = 'CUT';
        } else {
            const roundData = ls[currentRoundIdx] || {};
            const holeCount = (roundData.linescores || []).length;
            if (holeCount > 0) {
                thru = holeCount === 18 ? 'F' : holeCount;
            } else if (roundData.value > 0) {
                thru = 'F'; // round finished, hole data cleared
            } else if (competitor.status?.thru != null) {
                thru = competitor.status.thru === 18 ? 'F' : competitor.status.thru;
            }
        }

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
                return `<div class="group-player">
                    <span class="gp-num">${i + 1}</span>
                    <span class="gp-name">${name}</span>
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

    // Fixed group sizes: G1=6, G2=8, G3=10, G4=12, G5=rest
    const sizes = [6, 8, 10, 12];
    sizes.push(Math.max(0, n - 36));

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

function exportGroupsCSV() {
    // Build columns: one per group
    const cols = [];
    for (let g = 1; g <= 5; g++) {
        cols.push((groups[g] || []).map(id => {
            const p = playerMap[id];
            return p ? p.name : '';
        }));
    }
    const maxRows = Math.max(...cols.map(c => c.length));
    const lines = ['Group 1,Group 2,Group 3,Group 4,Group 5'];
    for (let r = 0; r < maxRows; r++) {
        lines.push(cols.map(col => col[r] || '').join(','));
    }
    const csv = lines.join('\n');

    // Download as file
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'masters-groups.csv';
    a.click();
    URL.revokeObjectURL(url);
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
    const sweep   = document.getElementById('sweepSelect').value || 'nab';
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
        sweep,
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
        const sweepLabel = (en.sweep || 'nab').toUpperCase();
        return `<div class="entry-card">
            <div>
                <div class="ec-name">${en.team} <span class="badge-sweep badge-${en.sweep || 'nab'}">${sweepLabel}</span></div>
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
// =============================================================
// BACKUP / RESTORE
// =============================================================
function exportStateBackup() {
    const snapshot = {
        exportedAt: new Date().toISOString(),
        groups,
        entries,
        bonus: bonusQuestions,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `masters-sweep-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importStateBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.entries || !data.groups) { alert('Invalid backup file.'); return; }
            if (!confirm(`Restore ${data.entries.length} entries from backup dated ${data.exportedAt?.slice(0,10) || 'unknown'}? This will replace current data.`)) return;
            groups         = data.groups;
            entries        = normalizeEntries(data.entries);
            bonusQuestions = Array.isArray(data.bonus) ? data.bonus : bonusQuestions;
            saveGroups();
            saveEntries();
            saveBonus();
            renderAll();
            alert(`Restored ${entries.length} entries successfully.`);
        } catch (err) {
            alert('Failed to read backup file: ' + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function renderBonusAdminPanel() {
    const el = document.getElementById('bonusAdminForm');
    if (!el) return;
    el.innerHTML = bonusQuestions.map((bq, i) => `
        <div class="bonus-admin-row">
            <div class="ba-question">Q${i + 1}: ${bq.question}</div>
            <div class="ba-answer-row">
                <input type="text" class="ba-input" id="baAns${i}" value="${bq.correctAnswer || ''}" placeholder="Enter correct answer...">
                <button class="btn btn-save-ans" onclick="saveSingleBonusAnswer(${i})">Save</button>
            </div>
            ${bq.correctAnswer ? `<div class="ba-set">Answer set: <strong>${bq.correctAnswer}</strong></div>` : ''}
        </div>
    `).join('');
}

function saveSingleBonusAnswer(idx) {
    const val = (document.getElementById(`baAns${idx}`)?.value || '').trim();
    if (bonusQuestions[idx]) {
        bonusQuestions[idx].correctAnswer = val;
        saveBonus();
        renderBonusAdminPanel();
        renderBonusDisplay();
        renderSweepLeaderboard();
    }
}

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

function formatShortAEST(isoOrDateStr) {
    try {
        const dt = new Date(isoOrDateStr);
        if (isNaN(dt.getTime())) return null;
        // Compact format: "10:26p" or "8:30a" (no space, single letter am/pm)
        const str = dt.toLocaleString('en-AU', {
            timeZone: 'Australia/Sydney',
            hour: 'numeric', minute: '2-digit', hour12: true,
        });
        return str.replace(/\s*(am|pm)$/i, m => m.trim()[0].toLowerCase());
    } catch { return null; }
}

function getPlayerThru(playerId) {
    const p = playerMap[playerId];
    if (!p) return '--';
    if (isPlayerCut(playerId)) return 'CUT';

    // 1. Nested hole linescores count (ESPN embeds per-hole data inside the round linescore)
    if (p.thruCount > 0) return p.thruCount === 18 ? 'F' : p.thruCount;

    // 2. Fallback: if the current round has a real value but no nested holes, round is finished
    const comp = getCompetition();
    const period = Number(comp?.status?.period || 1);
    const currentRoundData = p.linescores?.[Math.max(0, period - 1)] || {};
    if (currentRoundData.value > 0) return 'F';

    // 3. Legacy: status.thru (may exist in some API versions)
    const statusThru = p.status?.thru;
    if (statusThru != null && !hasCutMarker(String(statusThru))) {
        const n = Number(statusThru);
        if (!isNaN(n)) return n === 18 ? 'F' : n;
    }

    // 4. Player hasn't started — show tee time (AEST) if available
    if (p.teeTime) {
        const fmt = formatShortAEST(p.teeTime);
        if (fmt) return fmt;
    }
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
    // If the round is currently in progress, returns the live tournament leader(s).
    // If the round is complete, returns whoever led by total strokes at the end.
    const comp = getCompetition();
    if (!comp) return new Set();

    const period = Number(comp.status?.period || 1);

    // Round hasn't started yet — no bonus
    if (period < roundNum) return new Set();

    // Round is currently in progress — use live TO PAR leader
    if (period === roundNum) return getCurrentLeaders();

    // Round is complete — find leader by lowest raw stroke total
    let best = Infinity;
    let leaders = [];
    (comp.competitors || []).forEach(c => {
        const ls = c.linescores || [];
        let total = 0;
        let hasAll = true;
        for (let r = 0; r < roundNum; r++) {
            const v = ls[r]?.value;
            // Exclude nulls AND zero-value entries (not-started players have value=0)
            if (v == null || v === 0) { hasAll = false; break; }
            total += v;
        }
        if (!hasAll) return;
        if (total < best) { best = total; leaders = [c.id]; }
        else if (total === best) leaders.push(c.id);
    });
    return new Set(leaders);
}

function getCurrentLeaders() {
    // Returns Set of playerIds currently leading the tournament (lowest active score)
    const comp = getCompetition();
    if (!comp) return new Set();
    let best = Infinity;
    let leaders = [];
    (comp.competitors || []).forEach(c => {
        if (isPlayerCut(c.id)) return;
        const sc = parseScore(c.score);
        if (sc < best) { best = sc; leaders = [c.id]; }
        else if (sc === best) leaders.push(c.id);
    });
    return new Set(leaders);
}

function getTournamentWinners() {
    // Winner bonus only after all 4 rounds are fully complete.
    // ESPN uses state:'post' for each completed round, so we must ALSO check period >= 4.
    const comp = getCompetition();
    if (!comp) return new Set();
    const period = Number(comp.status?.period || 0);
    const state = getTournamentState();
    if (period < 4 || state !== 'post') return new Set();

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

    // All-5-made-cut bonus (-1) — only awarded once the cut has been made (Round 3+)
    const cutBonus = result.competitionType === 'main' && result.allMadeCut && isCutMade() ? -1 : 0;

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
    return 21 + bonusQuestions.length + (adminMode ? 1 : 0);
}

function getSweepHeaderHtml() {
    const adminCol = adminMode ? '<th></th>' : '';
    return `<tr>
        <th class="col-pos">Pos</th>
        <th class="col-team" style="text-align:left">Team</th>
        <th class="g1-head col-player-pick">Group 1</th><th class="g1-head col-sc">Sc</th><th class="g1-head col-thru" title="Holes completed (F=finished) or tee time (AEST) if not yet started">Thru</th>
        <th class="g2-head col-player-pick">Group 2</th><th class="g2-head col-sc">Sc</th><th class="g2-head col-thru" title="Holes completed (F=finished) or tee time (AEST) if not yet started">Thru</th>
        <th class="g3-head col-player-pick">Group 3</th><th class="g3-head col-sc">Sc</th><th class="g3-head col-thru" title="Holes completed (F=finished) or tee time (AEST) if not yet started">Thru</th>
        <th class="g4-head col-player-pick">Group 4</th><th class="g4-head col-sc">Sc</th><th class="g4-head col-thru" title="Holes completed (F=finished) or tee time (AEST) if not yet started">Thru</th>
        <th class="g5-head col-player-pick">Group 5</th><th class="g5-head col-sc">Sc</th><th class="g5-head col-thru" title="Holes completed (F=finished) or tee time (AEST) if not yet started">Thru</th>
        ${bonusQuestions.map((bq, i) => `<th class="col-bp" title="${bq.question}">BQ${i + 1}</th>`).join('')}
        <th class="col-bp col-bp-cut" title="All 5 players made the cut (-1)">Cut</th>
        <th class="col-bp col-bp-ldr" title="Round leader after R1/R2/R3 (-1 each) + Tournament winner (-2)">Ldr/Win</th>
        <th class="col-bp">BP Tot</th>
        <th class="col-total">Total</th>
        ${adminCol}
    </tr>`;
}

function buildGroupCells(entry, result) {
    const currentLeaders = getCurrentLeaders();
    const r1Leaders      = getLeadersAfterRound(1);
    const r2Leaders      = getLeadersAfterRound(2);
    const r3Leaders      = getLeadersAfterRound(3);
    const winners        = getTournamentWinners();

    return entry.picks.map((pid, gi) => {
        const ps = result.playerScores.find(p => p.playerId === pid);
        if (!ps) return `<td class="g${gi + 1}-cell col-player-pick">--</td><td class="g${gi + 1}-cell col-sc">--</td><td class="g${gi + 1}-cell col-thru">--</td>`;

        const dropped = ps.isDropped ? ' dropped-score' : '';
        const cutCls  = ps.isCut ? ' player-cut' : '';
        const scCls   = ps.isCut ? 'score-cut' : scoreClass(ps.score.toString());

        // Build leader badges (winner trophy only — R1/R2/R3 text badges removed to save space)
        const badgeHtml = winners.has(pid) ? `<span class="ldr-badge ldr-win" title="Tournament Winner">&#127942;</span>` : '';

        const nameCls = (currentLeaders.has(pid) && !ps.isCut) ? ' player-leading' : '';
        const winCls  = winners.has(pid) ? ' player-winner' : '';

        return `<td class="g${gi + 1}-cell col-player-pick${cutCls}${dropped}${nameCls}${winCls}">
                    ${ps.name}${badgeHtml}
                </td>
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
            const ans = (entry.bonusAnswers?.[i] || '').trim();
            const answered = ans !== '';
            const correct = bq.correctAnswer && answered && ans.toLowerCase() === bq.correctAnswer.trim().toLowerCase();
            const wrong = bq.correctAnswer && answered && !correct;
            if (correct) return `<td class="col-bp bp-correct" title="Correct!">&#10003;</td>`;
            if (wrong)   return `<td class="col-bp bp-wrong" title="Incorrect"><span class="bp-strikethrough">${ans}</span></td>`;
            return `<td class="col-bp">${answered ? ans : '--'}</td>`;
        }).join('');

        const cutBonusVal = result.competitionType === 'main' && result.allMadeCut && isCutMade() ? -1 : 0;
        const ldrWinVal = (-1 * result.leaderBonuses) + (result.winnerBonus ? -2 : 0);
        const cutCell = cutBonusVal !== 0
            ? `<td class="col-bp bp-correct" title="All 5 made the cut">${cutBonusVal}</td>`
            : `<td class="col-bp">--</td>`;
        const ldrCell = ldrWinVal !== 0
            ? `<td class="col-bp bp-ldr" title="${result.leaderBonuses} round leader(s)${result.winnerBonus ? ' + winner' : ''}">${ldrWinVal}</td>`
            : `<td class="col-bp">--</td>`;

        const deleteCol = adminMode ? `<td><button class="delete-btn" onclick="deleteEntry('${entry.id}')">&times;</button></td>` : '';
        const rowClass = rowClassFn(pos, entry, result);
        return `<tr class="${rowClass}">
            <td class="col-pos">${posStr}</td>
            <td class="col-team">${entry.team} <span class="entrant">(${entry.entrant})</span></td>
            ${groupCells}
            ${bpCells}
            ${cutCell}
            ${ldrCell}
            <td class="col-bp" style="font-weight:700">${fmtScoreNum(result.totalBonus)}</td>
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
                const ans = (entry.bonusAnswers?.[i] || '').trim();
                const answered = ans !== '';
                const correct = bq.correctAnswer && answered && ans.toLowerCase() === bq.correctAnswer.trim().toLowerCase();
                const wrong = bq.correctAnswer && answered && !correct;
                if (correct) return `<td class="col-bp bp-correct">&#10003;</td>`;
                if (wrong)   return `<td class="col-bp bp-wrong"><span class="bp-strikethrough">${ans}</span></td>`;
                return `<td class="col-bp">${answered ? ans : '--'}</td>`;
            }).join('');
            const deleteCol = adminMode ? `<td><button class="delete-btn" onclick="deleteEntry('${entry.id}')">&times;</button></td>` : '';

            return `<tr>
                <td class="col-pos">-</td>
                <td class="col-team">${entry.team} <span class="entrant">(${entry.entrant})</span></td>
                ${groupCells}
                ${bpCells}
                <td class="col-bp">--</td>
                <td class="col-bp">--</td>
                <td class="col-bp">${result.cutCount} CUT</td>
                <td class="col-total score-cut">CUT</td>
                ${deleteCol}
            </tr>`;
        });

    bodyEl.innerHTML = rows.join('');
}

function switchSweep(sw) {
    activeSweep = sw;
    document.querySelectorAll('.sweep-btn[data-sweep]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sweep === sw);
    });
    renderSweepLeaderboard();
}

function renderSweepLeaderboard() {
    const mainHead = document.getElementById('sweepHead');
    const mainBody = document.getElementById('sweepBody');
    const plateHead = document.getElementById('plateHead');
    const plateBody = document.getElementById('plateBody');

    // Update title
    const titleEl = document.getElementById('sweepTitle');
    if (titleEl) titleEl.innerHTML = `Sweepstake Leaderboards <span class="badge-sweep badge-${activeSweep}">${activeSweep.toUpperCase()}</span>`;

    // Filter entries by active sweep
    const sweepEntries = entries.filter(e => (e.sweep || 'nab') === activeSweep);

    if (!sweepEntries.length || Object.keys(playerMap).length === 0) {
        mainHead.innerHTML = '';
        plateHead.innerHTML = '';
        mainBody.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">No entries yet for this sweepstake, or waiting for ESPN data.</td></tr>`;
        plateBody.innerHTML = `<tr><td colspan="${getSweepTableColSpan()}" class="empty-cell">No teams currently in the plate competition.</td></tr>`;
        document.getElementById('sweepEntryCount').textContent = `${sweepEntries.length} entries`;
        document.getElementById('plateEntryCount').textContent = '0';
        renderEliminatedTeams([]);
        return;
    }

    const scored = sweepEntries.map(en => ({
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
    document.getElementById('sweepEntryCount').textContent = `${sweepEntries.length} entries (${mainRows.length} main, ${plateRows.length} plate, ${eliminatedRows.length} eliminated)`;
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
// DETAILED LEADERBOARD
// =============================================================
function switchDetailSweep(sw) {
    activeDetailSweep = sw;
    document.querySelectorAll('.sweep-btn[data-detail-sweep]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.detailSweep === sw);
    });
    renderDetailedLeaderboard();
}

function getNextTeeSydney(playerId) {
    const p = playerMap[playerId];
    if (!p || !p.teeTime) return null;
    try {
        const dt = new Date(p.teeTime);
        if (isNaN(dt.getTime())) return null;
        return dt.toLocaleString('en-AU', {
            timeZone: 'Australia/Sydney',
            weekday: 'short', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
        });
    } catch { return null; }
}

function renderDetailedLeaderboard() {
    const container = document.getElementById('detailContent');
    if (!container) return;

    const filterSweep = activeDetailSweep;
    const filtered = filterSweep === 'all'
        ? entries
        : entries.filter(e => (e.sweep || 'nab') === filterSweep);

    if (!filtered.length) {
        container.innerHTML = '<p class="empty-cell" style="padding:20px">No entries for this sweepstake yet.</p>';
        return;
    }

    const scored = filtered
        .map(en => ({ entry: en, result: calculateTeamScore(en) }))
        .sort((a, b) => {
            const aScore = a.result.grandTotal ?? 9999;
            const bScore = b.result.grandTotal ?? 9999;
            return aScore - bScore;
        });

    const roundLabels = ['R1', 'R2', 'R3', 'R4'];

    const cards = scored.map(({ entry, result }, idx) => {
        const sweepLabel = (entry.sweep || 'nab').toUpperCase();
        const totalDisplay = result.grandTotal !== null ? fmtScoreNum(result.grandTotal) : 'E';
        const totalClass = result.grandTotal !== null ? scoreClass(result.grandTotal.toString()) : '';
        const pos = idx + 1;

        const playerRows = result.playerScores.map((ps, gi) => {
            const roundCells = roundLabels.map((rl, ri) => {
                const raw = ps.roundScores[ri];
                const val = raw != null ? formatRoundStrokes(raw) : '-';
                const isLeading = !ps.isCut && getLeadersAfterRound(ri + 1).has(ps.playerId);
                return `<td class="dc-rd${isLeading ? ' dc-leading' : ''}" title="${isLeading ? 'Leading after ' + rl : ''}">${val}${isLeading ? ' &#9733;' : ''}</td>`;
            }).join('');

            const teeTime = getNextTeeSydney(ps.playerId);
            const teeCell = teeTime
                ? `<td class="dc-tee">${teeTime} AEST</td>`
                : `<td class="dc-tee dc-tee-none">${ps.isCut ? 'CUT' : '--'}</td>`;

            const cutCls = ps.isCut ? ' dc-cut' : '';
            const dropCls = ps.isDropped ? ' dc-dropped' : '';
            return `<tr class="${cutCls}${dropCls}">
                <td class="dc-gnum g${gi + 1}-cell">G${gi + 1}</td>
                <td class="dc-player">${ps.name}${ps.isDropped ? ' <span class="dc-drop-tag">dropped</span>' : ''}</td>
                ${roundCells}
                ${teeCell}
            </tr>`;
        }).join('');

        const bonusRows = bonusQuestions.map((bq, bi) => {
            const ans = (entry.bonusAnswers?.[bi] || '').trim();
            const correct = bq.correctAnswer && ans.toLowerCase() === bq.correctAnswer.trim().toLowerCase();
            const icon = bq.correctAnswer ? (correct ? '&#10003;' : '&#10007;') : '';
            const cls = bq.correctAnswer ? (correct ? 'dc-bq-correct' : 'dc-bq-wrong') : '';
            return `<tr class="dc-bonus-row">
                <td class="dc-bq-label" colspan="2">BQ${bi + 1}: ${bq.question}</td>
                <td class="dc-bq-ans ${cls}" colspan="4">${ans || '<em>no answer</em>'} ${icon}</td>
                <td class="dc-tee dc-bq-pts">${correct ? '-1 pt' : ''}</td>
            </tr>`;
        }).join('');

        const bonusBreakdown = [
            result.allMadeCut && isCutMade() ? '-1 (all made cut)' : '',
            result.leaderBonuses > 0 ? `-${result.leaderBonuses} (round leader)` : '',
            result.winnerBonus > 0 ? '-2 (winner)' : '',
            result.bonusCorrect > 0 ? `-${result.bonusCorrect} (bonus Qs)` : '',
        ].filter(Boolean).join(', ') || 'none';

        return `<div class="detail-card">
            <div class="detail-card-header">
                <span class="dc-pos">${pos}</span>
                <span class="dc-team">${entry.team}</span>
                <span class="dc-entrant">${entry.entrant}</span>
                <span class="badge-sweep badge-${entry.sweep || 'nab'}">${sweepLabel}</span>
                <span class="dc-bonus-summary">Bonuses: ${bonusBreakdown}</span>
                <span class="dc-total ${totalClass}">${totalDisplay}</span>
            </div>
            <div class="detail-card-body">
                <table class="detail-table">
                    <thead>
                        <tr>
                            <th class="dc-gnum">Grp</th>
                            <th class="dc-player">Player</th>
                            <th class="dc-rd">R1</th>
                            <th class="dc-rd">R2</th>
                            <th class="dc-rd">R3</th>
                            <th class="dc-rd">R4</th>
                            <th class="dc-tee">Next Tee (AEST)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${playerRows}
                        ${bonusRows}
                    </tbody>
                </table>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = cards;
}

// =============================================================
// ANALYTICS
// =============================================================
function renderAnalytics() {
    const container = document.getElementById('analyticsContent');
    if (!container) return;

    const nabEntries = entries.filter(e => (e.sweep || 'nab') === 'nab');
    const bnzEntries = entries.filter(e => (e.sweep || 'nab') === 'bnz');
    const total = entries.length;

    if (total === 0) {
        container.innerHTML = '<p class="empty-cell" style="padding:20px">No entries yet.</p>';
        return;
    }

    // --- Entry summary ---
    const summaryHtml = `
        <div class="analytics-grid">
            <div class="analytics-card">
                <div class="ac-label">Total Entries</div>
                <div class="ac-value">${total}</div>
            </div>
            <div class="analytics-card ac-nab">
                <div class="ac-label">NAB Sweepstake</div>
                <div class="ac-value">${nabEntries.length}</div>
            </div>
            <div class="analytics-card ac-bnz">
                <div class="ac-label">BNZ Sweepstake</div>
                <div class="ac-value">${bnzEntries.length}</div>
            </div>
        </div>`;

    // --- Pick distribution per group ---
    const dist = {};
    for (let g = 1; g <= 5; g++) {
        dist[g] = {};
        (groups[g] || []).forEach(pid => { dist[g][pid] = { nab: 0, bnz: 0 }; });
    }
    entries.forEach(e => {
        const sw = e.sweep || 'nab';
        e.picks.forEach((pid, idx) => {
            const g = idx + 1;
            if (!dist[g][pid]) dist[g][pid] = { nab: 0, bnz: 0 };
            dist[g][pid][sw]++;
        });
    });

    const groupPickHtml = [1, 2, 3, 4, 5].map(g => {
        const players = Object.entries(dist[g])
            .map(([pid, counts]) => ({
                pid,
                name: playerMap[pid]?.name || pid,
                total: counts.nab + counts.bnz,
                nab: counts.nab,
                bnz: counts.bnz,
            }))
            .sort((a, b) => b.total - a.total);

        const rows = players.map(p => {
            const pct = total > 0 ? Math.round((p.total / total) * 100) : 0;
            const nabPct = nabEntries.length > 0 ? Math.round((p.nab / nabEntries.length) * 100) : 0;
            const bnzPct = bnzEntries.length > 0 ? Math.round((p.bnz / bnzEntries.length) * 100) : 0;
            return `<tr>
                <td class="ap-name">${p.name}</td>
                <td class="ap-pct">
                    <div class="ap-bar-wrap">
                        <div class="ap-bar g${g}-bar" style="width:${pct}%"></div>
                    </div>
                    <span>${pct}%</span>
                </td>
                <td class="ap-count"><span class="badge-sweep badge-nab">${p.nab}</span></td>
                <td class="ap-count"><span class="badge-sweep badge-bnz">${p.bnz}</span></td>
            </tr>`;
        }).join('');

        return `<div class="analytics-group-card g${g}-group-header">
            <div class="ag-header">Group ${g} <span class="ag-hint">pick distribution</span></div>
            <table class="analytics-picks-table">
                <thead><tr><th>Player</th><th>All entries</th><th>NAB</th><th>BNZ</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }).join('');

    // --- Current leaders per sweep ---
    let leadersHtml = '';
    if (Object.keys(playerMap).length > 0) {
        const sweepScores = { nab: nabEntries, bnz: bnzEntries };
        const leaderCards = Object.entries(sweepScores).map(([sw, swEntries]) => {
            if (!swEntries.length) return '';
            const scored = swEntries
                .map(en => ({ entry: en, result: calculateTeamScore(en) }))
                .filter(s => s.result.grandTotal !== null)
                .sort((a, b) => a.result.grandTotal - b.result.grandTotal);
            if (!scored.length) return '';
            const leader = scored[0];
            return `<div class="analytics-card ac-${sw}">
                <div class="ac-label">${sw.toUpperCase()} Leader</div>
                <div class="ac-value">${leader.entry.team}</div>
                <div class="ac-sub">${leader.entry.entrant} &mdash; ${fmtScoreNum(leader.result.grandTotal)}</div>
            </div>`;
        }).join('');
        if (leaderCards.trim()) {
            leadersHtml = `<div class="analytics-section-title">Current Leaders</div><div class="analytics-grid">${leaderCards}</div>`;
        }
    }

    // --- Most popular picks ---
    const allPicks = {};
    entries.forEach(e => e.picks.forEach(pid => {
        allPicks[pid] = (allPicks[pid] || 0) + 1;
    }));
    const topPicks = Object.entries(allPicks)
        .map(([pid, cnt]) => ({ name: playerMap[pid]?.name || pid, cnt }))
        .sort((a, b) => b.cnt - a.cnt)
        .slice(0, 5);
    const topPicksHtml = topPicks.length ? `
        <div class="analytics-section-title">Most Popular Picks (all entries)</div>
        <div class="analytics-grid">
            ${topPicks.map(p => `
                <div class="analytics-card">
                    <div class="ac-label">${p.name}</div>
                    <div class="ac-value">${p.cnt}</div>
                    <div class="ac-sub">${Math.round((p.cnt / total) * 100)}% of teams</div>
                </div>`).join('')}
        </div>` : '';

    container.innerHTML = `
        <div class="analytics-section-title">Entry Summary</div>
        ${summaryHtml}
        ${leadersHtml}
        ${topPicksHtml}
        <div class="analytics-section-title">Pick Distribution by Group</div>
        <div class="analytics-groups-wrap">${groupPickHtml}</div>
    `;
}

// =============================================================
// ADMIN MODE
// =============================================================
const ADMIN_PASSWORD = 'masters';

function toggleAdmin() {
    if (!adminMode) {
        // Show password modal before activating
        document.getElementById('adminPwInput').value = '';
        document.getElementById('adminPwError').style.display = 'none';
        document.getElementById('adminPwModal').classList.add('open');
        setTimeout(() => document.getElementById('adminPwInput').focus(), 100);
    } else {
        // Deactivate immediately — no password needed to exit
        setAdminMode(false);
    }
}

function confirmAdminPassword() {
    const val = document.getElementById('adminPwInput').value;
    if (val === ADMIN_PASSWORD) {
        document.getElementById('adminPwModal').classList.remove('open');
        setAdminMode(true);
    } else {
        document.getElementById('adminPwError').style.display = 'block';
        document.getElementById('adminPwInput').value = '';
        document.getElementById('adminPwInput').focus();
    }
}

function closeAdminModal() {
    document.getElementById('adminPwModal').classList.remove('open');
}

function setAdminMode(on) {
    adminMode = on;
    document.body.classList.toggle('admin-mode', adminMode);
    document.getElementById('adminToggle').classList.toggle('active', adminMode);
    const enterBtn = document.querySelector('.tab-btn[data-tab="enter"]');
    if (enterBtn) enterBtn.style.display = adminMode ? '' : 'none';
    if (!adminMode && activeTab === 'enter') switchTab('sweep');
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

    // Tab navigation — Enter Team is admin-only; hide it by default
    const enterTabBtn = document.querySelector('.tab-btn[data-tab="enter"]');
    if (enterTabBtn) enterTabBtn.style.display = 'none';
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

    // Groups (read-only — search still works in admin)
    document.getElementById('unassignedSearch')?.addEventListener('input', () => renderUnassigned());

    // Player search (golf tab)
    document.getElementById('playerSearch')?.addEventListener('input', e => filterGolfPlayers(e.target.value));

    // Bonus questions
    document.getElementById('editBonusBtn')?.addEventListener('click', openBonusModal);
    document.getElementById('saveBonusBtn')?.addEventListener('click', saveBonusQuestions);
    document.getElementById('cancelBonusBtn')?.addEventListener('click', () => {
        document.getElementById('bonusModal').classList.remove('open');
    });

    // Sweep switcher buttons (Sweepstake tab)
    document.querySelectorAll('.sweep-btn[data-sweep]').forEach(btn => {
        btn.addEventListener('click', () => switchSweep(btn.dataset.sweep));
    });

    // Detail sweep switcher buttons (Detail tab)
    document.querySelectorAll('.sweep-btn[data-detail-sweep]').forEach(btn => {
        btn.addEventListener('click', () => switchDetailSweep(btn.dataset.detailSweep));
    });

    // Initial fetch
    fetchESPN();
    startAutoRefresh();
});

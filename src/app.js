const DATA_URL = "public/data/game-data.json";
const MIN_CELL_ANSWERS = 3;
const MAX_PUZZLE_ATTEMPTS = 5000;
const MAX_MISTAKES = 3;
const MAX_LINE_CLUES = 2;
const TRAINING_PUZZLE_LIMIT = 2;
const RULES_STORAGE_KEY = "vetki-rules-seen-v2";
const GAME_STORAGE_KEY = "vetki-game-state-v1";
const SHARE_URL = "https://svetlana-yatsyk.github.io/vetki_v_kletke/";
const ARCHIVE_START_DATE = "2026-06-28";
const DAILY_ROLLOVER_HOUR = 12;
const DAILY_TIME_ZONE = "Europe/Moscow";

const state = {
  data: null,
  puzzle: null,
  selected: null,
  answers: new Map(),
  intersectionCounts: new Map(),
  mistakes: 0,
  finished: false,
  trainingPuzzlesUsed: 0,
};

const grid = document.querySelector("#grid");
const searchInput = document.querySelector("#stationSearch");
const suggestions = document.querySelector("#suggestions");
const message = document.querySelector("#message");
const score = document.querySelector("#score");
const mistakes = document.querySelector("#mistakes");
const puzzleDate = document.querySelector("#puzzleDate");
const activeCellTitle = document.querySelector("#activeCellTitle");
const activeCellClues = document.querySelector("#activeCellClues");
const newPuzzleButton = document.querySelector("#newPuzzleButton");
const helpButton = document.querySelector("#helpButton");
const rulesDialog = document.querySelector("#rulesDialog");
const possibleAnswers = document.querySelector("#possibleAnswers");
const resultPanel = document.querySelector("#resultPanel");
const archiveList = document.querySelector("#archiveList");

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^а-яa-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = Math.imul(1664525, value) + 1013904223;
    return (value >>> 0) / 4294967296;
  };
}

function clueGroup(clue) {
  return clue.group === "type" ? "station_type" : clue.group;
}

function lineNameForConditionParts(label) {
  const name = label.replace(/\s+линия$/i, "").trim();
  if (name === "Московское центральное кольцо") {
    return ["На", "Московском центральном", "кольце"];
  }

  const inflected = name
    .split(" ")
    .map((word) => word.replace(/ая$/u, "ой").replace(/яя$/u, "ей"))
    .join(" ");
  return ["На", inflected, "ветке"];
}

function lineNameForCondition(label) {
  return lineNameForConditionParts(label).join(" ");
}

function clueLabel(clue) {
  if (clueGroup(clue) === "line") {
    return lineNameForCondition(clue.label);
  }
  return clue.label;
}

function clueWeight(clue) {
  const group = clueGroup(clue);
  if (group === "line") return 7;
  if (group === "station_type") return 0.18;
  if (group === "depth") return 0.7;
  if (group === "station_group") return 0.8;
  return 1.25;
}

function groupLimit(group) {
  if (group === "line") return MAX_LINE_CLUES;
  return 1;
}

function buildGroupCounts(selected) {
  const counts = new Map();
  for (const clue of selected) {
    const group = clueGroup(clue);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

function canUseClue(clue, selected, groupCounts) {
  const group = clueGroup(clue);
  if (selected.some((item) => item.id === clue.id)) return false;
  return (groupCounts.get(group) ?? 0) < groupLimit(group);
}

function pickWeighted(candidates, rng) {
  const total = candidates.reduce((sum, clue) => sum + clueWeight(clue), 0);
  let roll = rng() * total;
  for (const clue of candidates) {
    roll -= clueWeight(clue);
    if (roll <= 0) return clue;
  }
  return candidates.at(-1);
}

function selectAxisClues(clues, count, rng, selected, options = {}) {
  const result = [];
  const groupCounts = buildGroupCounts(selected);
  const lineTarget = options.lineTarget ?? 0;

  while (result.filter((clue) => clueGroup(clue) === "line").length < lineTarget) {
    const candidates = clues.filter(
      (clue) => clueGroup(clue) === "line" && canUseClue(clue, [...selected, ...result], groupCounts),
    );
    if (!candidates.length) return [];
    const clue = pickWeighted(candidates, rng);
    result.push(clue);
    groupCounts.set("line", (groupCounts.get("line") ?? 0) + 1);
  }

  while (result.length < count) {
    const candidates = clues.filter((clue) => {
      if (options.excludeLines && clueGroup(clue) === "line") return false;
      return canUseClue(clue, [...selected, ...result], groupCounts);
    });
    if (!candidates.length) return [];
    const clue = pickWeighted(candidates, rng);
    result.push(clue);
    const group = clueGroup(clue);
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }

  return result;
}

function stationMatchesClue(station, clue) {
  return station.tags.includes(clue.id);
}

function intersectionCount(rowClue, columnClue) {
  const key = `${rowClue.id}|${columnClue.id}`;
  if (state.intersectionCounts.has(key)) {
    return state.intersectionCounts.get(key);
  }

  const count = state.data.stations.filter(
    (station) => stationMatchesClue(station, rowClue) && stationMatchesClue(station, columnClue),
  ).length;
  state.intersectionCounts.set(key, count);
  return count;
}

function isUsablePuzzle(rows, columns) {
  const allClues = [...rows, ...columns];
  const ids = new Set(allClues.map((clue) => clue.id));
  if (ids.size !== allClues.length) return false;

  for (const row of rows) {
    for (const column of columns) {
      const count = intersectionCount(row, column);
      if (count < MIN_CELL_ANSWERS || count > 80) return false;
    }
  }
  return true;
}

function buildPuzzle(seedText = new Date().toISOString().slice(0, 10)) {
  const rng = createRng(hashString(seedText));
  const minCellAnswers = state.data.meta?.minCellAnswerCount ?? MIN_CELL_ANSWERS;
  const clues = state.data.clues.filter((clue) => clue.count >= minCellAnswers && clue.count <= 180);

  for (let attempt = 0; attempt < MAX_PUZZLE_ATTEMPTS; attempt += 1) {
    const lineAxis = rng() < 0.5 ? "rows" : "columns";
    const lineTarget = MAX_LINE_CLUES;
    let rows = [];
    let columns = [];

    if (lineAxis === "rows") {
      rows = selectAxisClues(clues, 3, rng, [], { lineTarget });
      columns = selectAxisClues(clues, 3, rng, rows, { excludeLines: true });
    } else {
      columns = selectAxisClues(clues, 3, rng, [], { lineTarget });
      rows = selectAxisClues(clues, 3, rng, columns, { excludeLines: true });
    }

    if (isUsablePuzzle(rows, columns)) {
      return { id: seedText, rows, columns };
    }
  }

  return {
    id: "fallback",
    rows: clues.slice(0, 3),
    columns: clues.slice(3, 6),
  };
}

function renderGrid() {
  grid.innerHTML = "";
  grid.append(createCell("corner-cell", ""));

  for (const clue of state.puzzle.columns) {
    grid.append(createClueCell("column", clue));
  }

  state.puzzle.rows.forEach((rowClue, rowIndex) => {
    grid.append(createClueCell("row", rowClue));
    state.puzzle.columns.forEach((columnClue, columnIndex) => {
      const key = `${rowIndex}:${columnIndex}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "grid-cell";
      button.dataset.key = key;
      button.dataset.row = rowIndex;
      button.dataset.column = columnIndex;
      button.setAttribute("role", "gridcell");
      button.addEventListener("click", () => selectCell(rowIndex, columnIndex));
      renderAnswer(button, key);
      if (state.finished && !state.answers.has(key)) {
        button.classList.add("revealed");
      }
      grid.append(button);
    });
  });

  updateScore();
}

function createCell(className, text) {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

function createClueCell(axis, clue) {
  const element = document.createElement("div");
  element.className = `clue-cell ${axis}${clueGroup(clue) === "line" ? " line-clue" : ""}`;
  if (clueGroup(clue) === "line") {
    for (const part of lineNameForConditionParts(clue.label)) {
      const line = document.createElement("span");
      line.textContent = part;
      element.append(line);
    }
    return element;
  }

  element.textContent = clue.label;
  return element;
}

function renderAnswer(button, key) {
  const answer = state.answers.get(key);
  if (!answer) {
    button.innerHTML = '<span class="cell-placeholder">+</span>';
    return;
  }
  button.classList.add("correct");
  button.innerHTML = `
    <span class="answer-name">${answer.nameRu}</span>
    <span class="answer-line">${answer.lineNameRu}</span>
  `;
}

function selectCell(rowIndex, columnIndex) {
  const key = `${rowIndex}:${columnIndex}`;
  state.selected = { rowIndex, columnIndex };
  document.querySelectorAll(".grid-cell").forEach((cell) => cell.classList.remove("active"));
  const active = document.querySelector(`[data-key="${key}"]`);
  active?.classList.add("active");

  const rowClue = state.puzzle.rows[rowIndex];
  const columnClue = state.puzzle.columns[columnIndex];
  activeCellTitle.textContent = `Строка ${rowIndex + 1}, столбец ${columnIndex + 1}`;
  activeCellClues.textContent = `${clueLabel(rowClue)} + ${clueLabel(columnClue)}`;
  possibleAnswers.hidden = true;

  if (state.finished) {
    searchInput.value = "";
    suggestions.innerHTML = "";
    showPossibleAnswers(rowIndex, columnIndex);
    return;
  }

  if (state.answers.has(key)) {
    message.textContent = "Эта клетка уже заполнена.";
    return;
  }

  searchInput.value = "";
  suggestions.innerHTML = "";
  message.textContent = "";
  searchInput.focus();
}

function showSuggestions() {
  suggestions.innerHTML = "";
  if (state.finished) return;
  const query = normalize(searchInput.value);
  if (!query || query.length < 2) return;

  const usedIds = new Set([...state.answers.values()].map((station) => station.id));
  const matches = state.data.stations
    .filter((station) => !usedIds.has(station.id) && station.searchText.includes(query))
    .slice(0, 8);

  for (const station of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.innerHTML = `${station.nameRu}<small>${station.lineNameRu}</small>`;
    button.addEventListener("click", () => submitStation(station));
    suggestions.append(button);
  }
}

function submitStation(station) {
  if (state.finished) {
    message.textContent = "Партия уже завершена.";
    return;
  }

  if (!state.selected) {
    message.textContent = "Сначала выбери клетку.";
    return;
  }

  const key = `${state.selected.rowIndex}:${state.selected.columnIndex}`;
  if (state.answers.has(key)) {
    message.textContent = "Эта клетка уже заполнена.";
    return;
  }

  const usedStation = [...state.answers.values()].some((answer) => answer.id === station.id);
  if (usedStation) {
    message.textContent = "Эта станция на этой линии уже использована.";
    return;
  }

  const rowClue = state.puzzle.rows[state.selected.rowIndex];
  const columnClue = state.puzzle.columns[state.selected.columnIndex];
  const ok = stationMatchesClue(station, rowClue) && stationMatchesClue(station, columnClue);

  if (!ok) {
    state.mistakes += 1;
    message.textContent =
      state.mistakes >= MAX_MISTAKES ? "Третья ошибка. Партия завершена." : "Не подходит под оба условия.";
    updateScore();
    const active = document.querySelector(`[data-key="${key}"]`);
    active?.classList.add("wrong");
    setTimeout(() => active?.classList.remove("wrong"), 650);
    if (state.mistakes >= MAX_MISTAKES) {
      finishPuzzle(false);
    } else {
      saveGameState();
    }
    return;
  }

  state.answers.set(key, station);
  message.textContent = "Есть!";
  renderGrid();
  selectNextCell();
  saveGameState();
}

function selectNextCell() {
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
      if (!state.answers.has(`${rowIndex}:${columnIndex}`)) {
        selectCell(rowIndex, columnIndex);
        return;
      }
    }
  }
  state.selected = null;
  activeCellTitle.textContent = "Сетка заполнена";
  activeCellClues.textContent = "Теперь можно нажимать на клетки и смотреть возможные ответы.";
  finishPuzzle(true);
}

function updateScore() {
  score.textContent = `${state.answers.size}/9`;
  mistakes.textContent = `Ошибки ${state.mistakes}/${MAX_MISTAKES}`;
  updateTrainingButton();
}

function updateTrainingButton() {
  const remaining = TRAINING_PUZZLE_LIMIT - state.trainingPuzzlesUsed;
  newPuzzleButton.disabled = remaining <= 0;
  newPuzzleButton.textContent = remaining <= 0 ? "Лимит исчерпан" : "Поиграть ещё";
  newPuzzleButton.title =
    remaining <= 0 ? "Сегодня уже использованы две тренировочные сетки." : `Осталось тренировочных сеток: ${remaining}`;
}

function finishPuzzle(won) {
  state.finished = true;
  state.selected = null;
  searchInput.disabled = true;
  suggestions.innerHTML = "";
  renderGrid();
  renderResult(won);
  message.textContent = won ? "Ура, сетка собрана!" : "Партия закончилась.";
  if (!won) {
    activeCellTitle.textContent = "Партия завершена";
    activeCellClues.textContent = "Три ошибки уже использованы.";
  }
  saveGameState();
}

function renderResult(won) {
  const perfectBadge = won && state.mistakes === 0 ? '<p class="perfect-badge">Идеальная сетка</p>' : "";
  if (won) {
    resultPanel.innerHTML = `
      <h3>Победа!</h3>
      ${perfectBadge}
      <p>Отличный результат. Возвращайтесь завтра за новой сеткой и расскажите про игру друзьям.</p>
      <dl>
        <div><dt>Ошибки</dt><dd>${state.mistakes}/${MAX_MISTAKES}</dd></div>
      </dl>
      <button class="share-button" type="button" data-share-result>Поделиться</button>
    `;
  } else {
    resultPanel.innerHTML = `
      <h3>Есть куда стремиться</h3>
      <p>Можно открыть возможные ответы и попробовать новую сетку.</p>
      <dl>
        <div><dt>Заполнено</dt><dd>${state.answers.size}/9</dd></div>
        <div><dt>Ошибки</dt><dd>${state.mistakes}/${MAX_MISTAKES}</dd></div>
      </dl>
      <button class="share-button" type="button" data-share-result>Поделиться</button>
    `;
  }
  resultPanel.hidden = false;
}

function shareText() {
  const dateText = formatDate(state.puzzle.id);
  const title = dateText ? `Ветки в клетке, ${dateText}` : "Ветки в клетке";
  const cells = Array.from({ length: 9 }, (_, index) => (index < state.answers.size ? "🟩" : "⬜"));
  const gridRows = [cells.slice(0, 3).join(""), cells.slice(3, 6).join(""), cells.slice(6, 9).join("")].join("\n");
  return `${title}: у меня ${state.answers.size} станций из 9, ${state.mistakes} ошибок.\n${gridRows}\n${SHARE_URL}`;
}

async function shareResult() {
  const text = shareText();
  try {
    if (navigator.share) {
      await navigator.share({ title: "Ветки в клетке", text });
      return;
    }

    await navigator.clipboard.writeText(text);
    message.textContent = "Результат скопирован.";
  } catch (error) {
    if (error.name !== "AbortError") {
      message.textContent = "Не удалось поделиться результатом.";
      console.error(error);
    }
  }
}

function matchingStations(rowIndex, columnIndex) {
  const rowClue = state.puzzle.rows[rowIndex];
  const columnClue = state.puzzle.columns[columnIndex];
  return state.data.stations.filter(
    (station) => stationMatchesClue(station, rowClue) && stationMatchesClue(station, columnClue),
  );
}

function showPossibleAnswers(rowIndex, columnIndex) {
  const stations = matchingStations(rowIndex, columnIndex);
  const answer = state.answers.get(`${rowIndex}:${columnIndex}`);
  const title = answer ? `Подходит: ${answer.nameRu}` : "Возможные ответы";
  possibleAnswers.innerHTML = `
    <h3>${title}</h3>
    <ul>
      ${stations
        .slice(0, 16)
        .map((station) => `<li>${station.nameRu}<span>${station.lineNameRu}</span></li>`)
        .join("")}
    </ul>
  `;
  possibleAnswers.hidden = false;
  message.textContent =
    stations.length > 16 ? `Показаны первые 16 вариантов из ${stations.length}.` : `${stations.length} вариантов.`;
}

function startPuzzle(seedText) {
  state.puzzle = buildPuzzle(seedText);
  state.answers.clear();
  state.mistakes = 0;
  state.finished = false;
  searchInput.disabled = false;
  possibleAnswers.hidden = true;
  resultPanel.hidden = true;
  resultPanel.innerHTML = "";
  message.textContent = "";
  renderGrid();
  renderPuzzleDate(seedText);
  selectCell(0, 0);
  saveGameState();
}

function dateSeedFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(seedText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seedText);
  if (!match) return "";
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function dateFromSeed(seedText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seedText);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function addDays(seedText, days) {
  const date = dateFromSeed(seedText);
  if (!date) return "";
  date.setDate(date.getDate() + days);
  return dateSeedFromDate(date);
}

function currentPuzzleSeed(date = new Date()) {
  const moscowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((parts, part) => {
      parts[part.type] = part.value;
      return parts;
    }, {});

  let seed = `${moscowParts.year}-${moscowParts.month}-${moscowParts.day}`;
  if (Number(moscowParts.hour) < DAILY_ROLLOVER_HOUR) {
    seed = addDays(seed, -1);
  }
  return seed;
}

function renderPuzzleDate(seedText) {
  const dateText = formatDate(seedText);
  puzzleDate.textContent = dateText ? `Сетка ${dateText}` : "Тренировочная сетка";
}

function renderArchive() {
  archiveList.innerHTML = "";
  const currentSeed = currentPuzzleSeed();
  let seed = addDays(currentSeed, -1);
  const archiveSeeds = [];
  while (seed && seed >= ARCHIVE_START_DATE) {
    archiveSeeds.push(seed);
    seed = addDays(seed, -1);
  }

  if (!archiveSeeds.length) {
    archiveList.innerHTML = '<p class="muted">Архив появится после первой смены дневной сетки.</p>';
    return;
  }

  for (const archiveSeed of archiveSeeds) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "archive-button secondary-button";
    button.dataset.archiveSeed = archiveSeed;
    button.textContent = formatDate(archiveSeed);
    archiveList.append(button);
  }
}

function stationById(id) {
  return state.data.stations.find((station) => station.id === id);
}

function saveGameState() {
  const saved = {
    puzzleDay: currentPuzzleSeed(),
    puzzleId: state.puzzle?.id,
    answers: [...state.answers.entries()].map(([key, station]) => [key, station.id]),
    mistakes: state.mistakes,
    finished: state.finished,
    trainingPuzzlesUsed: state.trainingPuzzlesUsed,
  };
  localStorage.setItem(GAME_STORAGE_KEY, JSON.stringify(saved));
}

function restoreGameState() {
  const raw = localStorage.getItem(GAME_STORAGE_KEY);
  if (!raw) return false;

  try {
    const saved = JSON.parse(raw);
    if (saved.puzzleDay !== currentPuzzleSeed() || !saved.puzzleId) return false;

    state.puzzle = buildPuzzle(saved.puzzleId);
    state.answers.clear();
    for (const [key, stationId] of saved.answers ?? []) {
      const station = stationById(stationId);
      if (station) {
        state.answers.set(key, station);
      }
    }
    state.mistakes = Math.min(Number(saved.mistakes) || 0, MAX_MISTAKES);
    state.finished = Boolean(saved.finished);
    state.trainingPuzzlesUsed = Math.min(Number(saved.trainingPuzzlesUsed) || 0, TRAINING_PUZZLE_LIMIT);
    searchInput.disabled = state.finished;
    possibleAnswers.hidden = true;
    resultPanel.hidden = true;
    resultPanel.innerHTML = "";
    message.textContent = "";
    renderGrid();
    renderPuzzleDate(saved.puzzleId);
    if (state.finished) {
      renderResult(state.answers.size === 9 && state.mistakes < MAX_MISTAKES);
      activeCellTitle.textContent = state.answers.size === 9 ? "Сетка заполнена" : "Партия завершена";
      activeCellClues.textContent =
        state.answers.size === 9 ? "Теперь можно нажимать на клетки и смотреть возможные ответы." : "Три ошибки уже использованы.";
      return true;
    }
    selectNextCell();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function startTrainingPuzzle() {
  if (state.trainingPuzzlesUsed >= TRAINING_PUZZLE_LIMIT) {
    message.textContent = "Сегодня уже использованы две тренировочные сетки.";
    updateTrainingButton();
    return;
  }
  state.trainingPuzzlesUsed += 1;
  startPuzzle(`training-${currentPuzzleSeed()}-${state.trainingPuzzlesUsed}-${Date.now()}`);
}

function startArchivedPuzzle(seedText) {
  startPuzzle(seedText);
  message.textContent = "Открыта архивная сетка.";
}

function showRules() {
  if (rulesDialog?.showModal) {
    rulesDialog.showModal();
  }
}

async function init() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Не удалось загрузить ${DATA_URL}`);
  state.data = await response.json();
  renderArchive();
  if (!restoreGameState()) {
    state.trainingPuzzlesUsed = 0;
    startPuzzle(currentPuzzleSeed());
  }
  scheduleDailyRollover();
  if (!localStorage.getItem(RULES_STORAGE_KEY)) {
    showRules();
    localStorage.setItem(RULES_STORAGE_KEY, "1");
  }
}

searchInput.addEventListener("input", showSuggestions);
newPuzzleButton.addEventListener("click", startTrainingPuzzle);
helpButton.addEventListener("click", showRules);
archiveList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-archive-seed]");
  if (button) {
    startArchivedPuzzle(button.dataset.archiveSeed);
  }
});
resultPanel.addEventListener("click", (event) => {
  if (event.target.closest("[data-share-result]")) {
    shareResult();
  }
});

function scheduleDailyRollover() {
  const now = new Date();
  const currentSeed = currentPuzzleSeed(now);
  const nextSeed = addDays(currentSeed, 1);
  const nextNoon = new Date(`${nextSeed}T09:00:00.000Z`);

  window.setTimeout(() => {
    const newSeed = currentPuzzleSeed();
    const previousSeed = addDays(newSeed, -1);
    renderArchive();
    state.trainingPuzzlesUsed = 0;
    if (state.puzzle?.id === previousSeed) {
      startPuzzle(newSeed);
    } else {
      updateTrainingButton();
      saveGameState();
    }
    scheduleDailyRollover();
  }, nextNoon.getTime() - now.getTime());
}

init().catch((error) => {
  message.textContent = "Не удалось загрузить данные. Запусти scripts/build_game_data.py.";
  console.error(error);
});

const DATA_URL = "public/data/game-data.json";
const MIN_CELL_ANSWERS = 3;
const MAX_PUZZLE_ATTEMPTS = 5000;
const MAX_MISTAKES = 3;
const MAX_LINE_CLUES = 2;
const RULES_STORAGE_KEY = "vetki-rules-seen-v2";

const state = {
  data: null,
  puzzle: null,
  selected: null,
  answers: new Map(),
  intersectionCounts: new Map(),
  mistakes: 0,
  finished: false,
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
    }
    return;
  }

  state.answers.set(key, station);
  message.textContent = "Есть!";
  renderGrid();
  selectNextCell();
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
}

function finishPuzzle(won) {
  state.finished = true;
  state.selected = null;
  searchInput.disabled = true;
  suggestions.innerHTML = "";
  renderGrid();
  renderResult(won);
  message.textContent = won ? "Поздравляем, сетка собрана!" : "Партия закончилась.";
  if (!won) {
    activeCellTitle.textContent = "Партия завершена";
    activeCellClues.textContent = "Три ошибки уже использованы.";
  }
}

function gridRating() {
  const completionScore = (state.answers.size / 9) * 100;
  const mistakePenalty = state.mistakes * 10;
  return Math.max(0, Math.round(completionScore - mistakePenalty));
}

function ratingTitle(rating, won) {
  if (!won) return "Есть куда разогнаться";
  if (rating >= 95) return "Блестящая сетка";
  if (rating >= 80) return "Очень сильная сетка";
  if (rating >= 65) return "Уверенная победа";
  return "Победа";
}

function renderResult(won) {
  const rating = gridRating();
  resultPanel.innerHTML = `
    <h3>${ratingTitle(rating, won)}</h3>
    <p>${won ? "Поздравляем! Вы заполнили все 9 клеток." : "Можно открыть возможные ответы и попробовать новую сетку."}</p>
    <dl>
      <div><dt>Оценка сетки</dt><dd>${rating}</dd></div>
      <div><dt>Заполнено</dt><dd>${state.answers.size}/9</dd></div>
      <div><dt>Ошибки</dt><dd>${state.mistakes}/${MAX_MISTAKES}</dd></div>
    </dl>
  `;
  resultPanel.hidden = false;
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
}

function formatDate(seedText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seedText);
  if (!match) return "";
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function localDateSeed(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderPuzzleDate(seedText) {
  const dateText = formatDate(seedText);
  puzzleDate.textContent = dateText ? `Сетка ${dateText}` : "Тренировочная сетка";
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
  startPuzzle(localDateSeed());
  if (!localStorage.getItem(RULES_STORAGE_KEY)) {
    showRules();
    localStorage.setItem(RULES_STORAGE_KEY, "1");
  }
}

searchInput.addEventListener("input", showSuggestions);
newPuzzleButton.addEventListener("click", () => startPuzzle(`training-${Date.now()}`));
helpButton.addEventListener("click", showRules);

init().catch((error) => {
  message.textContent = "Не удалось загрузить данные. Запусти scripts/build_game_data.py.";
  console.error(error);
});

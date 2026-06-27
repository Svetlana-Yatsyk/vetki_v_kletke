const DATA_URL = "public/data/game-data.json";
const MIN_CELL_ANSWERS = 3;
const MAX_PUZZLE_ATTEMPTS = 5000;

const state = {
  data: null,
  puzzle: null,
  selected: null,
  answers: new Map(),
  intersectionCounts: new Map(),
};

const grid = document.querySelector("#grid");
const searchInput = document.querySelector("#stationSearch");
const suggestions = document.querySelector("#suggestions");
const message = document.querySelector("#message");
const score = document.querySelector("#score");
const activeCellTitle = document.querySelector("#activeCellTitle");
const activeCellClues = document.querySelector("#activeCellClues");
const newPuzzleButton = document.querySelector("#newPuzzleButton");

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

function sample(items, count, rng) {
  const pool = [...items];
  const result = [];
  while (pool.length && result.length < count) {
    const index = Math.floor(rng() * pool.length);
    result.push(pool.splice(index, 1)[0]);
  }
  return result;
}

function sampleUniqueGroups(items, count, rng, excludedGroups = new Set()) {
  const groups = new Map();

  for (const item of items) {
    if (excludedGroups.has(item.group)) continue;
    if (!groups.has(item.group)) {
      groups.set(item.group, []);
    }
    groups.get(item.group).push(item);
  }

  const selectedGroups = sample([...groups.keys()], count, rng);
  if (selectedGroups.length < count) return [];

  return selectedGroups.map((group) => {
    const groupItems = groups.get(group);
    return groupItems[Math.floor(rng() * groupItems.length)];
  });
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
  const groups = new Set(allClues.map((clue) => clue.group));
  if (groups.size !== allClues.length) return false;

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
    const rows = sampleUniqueGroups(clues, 3, rng);
    const rowGroups = new Set(rows.map((row) => row.group));
    const columnPool = clues.filter((clue) => !rows.some((row) => row.id === clue.id));
    const columns = sampleUniqueGroups(columnPool, 3, rng, rowGroups);
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
    grid.append(createCell("clue-cell column", clue.label));
  }

  state.puzzle.rows.forEach((rowClue, rowIndex) => {
    grid.append(createCell("clue-cell row", rowClue.label));
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
  state.selected = { rowIndex, columnIndex };
  document.querySelectorAll(".grid-cell").forEach((cell) => cell.classList.remove("active"));
  const active = document.querySelector(`[data-key="${rowIndex}:${columnIndex}"]`);
  active?.classList.add("active");

  const rowClue = state.puzzle.rows[rowIndex];
  const columnClue = state.puzzle.columns[columnIndex];
  activeCellTitle.textContent = `Строка ${rowIndex + 1}, столбец ${columnIndex + 1}`;
  activeCellClues.textContent = `${rowClue.label} + ${columnClue.label}`;
  searchInput.value = "";
  suggestions.innerHTML = "";
  message.textContent = "";
  searchInput.focus();
}

function showSuggestions() {
  suggestions.innerHTML = "";
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
  if (!state.selected) {
    message.textContent = "Сначала выбери клетку.";
    return;
  }

  const key = `${state.selected.rowIndex}:${state.selected.columnIndex}`;
  if (state.answers.has(key)) {
    message.textContent = "Эта клетка уже заполнена.";
    return;
  }

  const rowClue = state.puzzle.rows[state.selected.rowIndex];
  const columnClue = state.puzzle.columns[state.selected.columnIndex];
  const ok = stationMatchesClue(station, rowClue) && stationMatchesClue(station, columnClue);

  if (!ok) {
    message.textContent = "Не подходит под оба условия.";
    const active = document.querySelector(`[data-key="${key}"]`);
    active?.classList.add("wrong");
    setTimeout(() => active?.classList.remove("wrong"), 650);
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
  activeCellClues.textContent = "Можно попробовать новую тренировочную сетку.";
}

function updateScore() {
  score.textContent = `${state.answers.size}/9`;
}

function startPuzzle(seedText) {
  state.puzzle = buildPuzzle(seedText);
  state.answers.clear();
  renderGrid();
  selectCell(0, 0);
}

async function init() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Не удалось загрузить ${DATA_URL}`);
  state.data = await response.json();
  startPuzzle(new Date().toISOString().slice(0, 10));
}

searchInput.addEventListener("input", showSuggestions);
newPuzzleButton.addEventListener("click", () => startPuzzle(`training-${Date.now()}`));

init().catch((error) => {
  message.textContent = "Не удалось загрузить данные. Запусти scripts/build_game_data.py.";
  console.error(error);
});

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

DEFAULT_SOURCE = Path("../moscow-metro-doku-data/data/processed/stations_base_with_wikipedia_map.csv")
DEFAULT_OUTPUT = Path("public/data/game-data.json")
VOWELS = set("аеёиоуыэюя")


def normalize(value: Any) -> str:
    text = str(value or "").strip().lower().replace("ё", "е")
    text = re.sub(r"[^а-яa-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def parse_int(value: Any) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_float(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def first_letter(value: str) -> str:
    for char in normalize(value):
        if "а" <= char <= "я":
            return char
    return ""


def word_count(value: str) -> int:
    return len(re.findall(r"[а-яё]+(?:-[а-яё]+)*", value.lower()))


def add_tag(tags: set[str], tag_id: str) -> None:
    if tag_id:
        tags.add(tag_id)


def station_tags(row: dict[str, str]) -> list[str]:
    tags: set[str] = set()
    line_id = str(row.get("line_id", "")).strip()
    opened_year = parse_int(row.get("opened_year"))
    depth = parse_float(row.get("depth_m"))
    order_on_line = parse_int(row.get("wiki_map_station_order_on_line"))
    station_type = normalize(row.get("station_type"))
    name = row.get("name_ru", "")
    first = first_letter(name)

    add_tag(tags, f"line:{line_id}")
    add_tag(tags, "transfer:yes" if parse_bool(row.get("is_transfer")) else "transfer:no")
    add_tag(tags, "future:yes" if parse_bool(row.get("wiki_map_future")) else "future:no")

    if opened_year:
        if opened_year < 1950:
            add_tag(tags, "opened:before_1950")
        if 1950 <= opened_year <= 1989:
            add_tag(tags, "opened:soviet_late")
        if 1990 <= opened_year <= 2009:
            add_tag(tags, "opened:1990_2000s")
        if opened_year >= 2010:
            add_tag(tags, "opened:2010s_plus")

    if depth is not None:
        abs_depth = abs(depth)
        if abs_depth >= 40:
            add_tag(tags, "depth:deep")
        if abs_depth <= 12:
            add_tag(tags, "depth:shallow")

    if station_type:
        if "pylon" in station_type:
            add_tag(tags, "type:pylon")
        if "column" in station_type:
            add_tag(tags, "type:column")
        if "single vault" in station_type or "single-vault" in station_type:
            add_tag(tags, "type:single_vault")
        if "surface" in station_type or "elevated" in station_type:
            add_tag(tags, "type:surface")

    if first:
        add_tag(tags, "name:starts_vowel" if first in VOWELS else "name:starts_consonant")
    if word_count(name) == 1:
        add_tag(tags, "name:one_word")
    if "-" in name:
        add_tag(tags, "name:hyphen")
    if "имени" in normalize(name):
        add_tag(tags, "name:has_imeni")

    if order_on_line == 1 or not row.get("wiki_map_prev_station_name") or not row.get("wiki_map_next_station_name"):
        add_tag(tags, "position:terminal")
    else:
        add_tag(tags, "position:not_terminal")

    return sorted(tags)


def build_station(row: dict[str, str]) -> dict[str, Any]:
    station_id = row.get("station_id") or f"{normalize(row.get('name_ru'))}:{row.get('line_id')}"
    return {
        "id": station_id,
        "groupId": row.get("station_group_id") or station_id,
        "nameRu": row.get("name_ru", ""),
        "nameEn": row.get("name_en", ""),
        "lineId": str(row.get("line_id", "")).strip(),
        "lineNameRu": row.get("line_name_ru", ""),
        "lineColor": row.get("line_color") or row.get("wiki_map_line_color") or "",
        "openedYear": parse_int(row.get("opened_year")),
        "depthM": parse_float(row.get("depth_m")),
        "stationType": row.get("station_type", ""),
        "isTransfer": parse_bool(row.get("is_transfer")),
        "isFuture": parse_bool(row.get("wiki_map_future")),
        "orderOnLine": parse_int(row.get("wiki_map_station_order_on_line")),
        "prevStationName": row.get("wiki_map_prev_station_name", ""),
        "nextStationName": row.get("wiki_map_next_station_name", ""),
        "tags": station_tags(row),
        "searchText": normalize(" ".join([row.get("name_ru", ""), row.get("name_en", ""), row.get("line_name_ru", "")]))
    }


def base_clues(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    clues = [
        {"id": "transfer:yes", "label": "Есть пересадка", "group": "transfer"},
        {"id": "transfer:no", "label": "Без пересадки", "group": "transfer"},
        {"id": "future:no", "label": "Не будущая станция", "group": "status"},
        {"id": "opened:before_1950", "label": "Открыта до 1950", "group": "opened"},
        {"id": "opened:soviet_late", "label": "Открыта в 1950-1989", "group": "opened"},
        {"id": "opened:1990_2000s", "label": "Открыта в 1990-2000-е", "group": "opened"},
        {"id": "opened:2010s_plus", "label": "Открыта с 2010 года", "group": "opened"},
        {"id": "depth:deep", "label": "Глубже 40 метров", "group": "depth"},
        {"id": "depth:shallow", "label": "Мелкого заложения", "group": "depth"},
        {"id": "type:pylon", "label": "Пилонная станция", "group": "type"},
        {"id": "type:column", "label": "Колонная станция", "group": "type"},
        {"id": "type:single_vault", "label": "Односводчатая", "group": "type"},
        {"id": "type:surface", "label": "Наземная или эстакадная", "group": "type"},
        {"id": "name:starts_vowel", "label": "Начинается на гласную", "group": "name"},
        {"id": "name:starts_consonant", "label": "Начинается на согласную", "group": "name"},
        {"id": "name:one_word", "label": "Название из одного слова", "group": "name"},
        {"id": "name:hyphen", "label": "В названии есть дефис", "group": "name"},
        {"id": "position:terminal", "label": "Конечная на линии", "group": "position"},
        {"id": "position:not_terminal", "label": "Не конечная", "group": "position"},
    ]

    line_labels: dict[str, str] = {}
    for row in rows:
        line_id = str(row.get("line_id", "")).strip()
        line_name = row.get("line_name_ru", "").strip()
        if line_id and line_name:
            line_labels.setdefault(line_id, line_name)

    for line_id, line_name in sorted(line_labels.items(), key=lambda item: item[0]):
        clues.append({"id": f"line:{line_id}", "label": line_name, "group": "line"})

    return clues


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    if not args.source.exists():
        raise FileNotFoundError(f"Source CSV not found: {args.source}")

    with args.source.open(newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))

    stations = [build_station(row) for row in rows if row.get("name_ru") and row.get("line_id")]
    clues = base_clues(rows)

    tag_counts: dict[str, int] = {}
    for station in stations:
        for tag in station["tags"]:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    clues = [dict(clue, count=tag_counts.get(clue["id"], 0)) for clue in clues]
    clues = [clue for clue in clues if clue["count"] >= 3]

    payload = {
        "meta": {
            "source": str(args.source),
            "stationCount": len(stations),
            "clueCount": len(clues),
        },
        "stations": stations,
        "clues": clues,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {args.output} with {len(stations)} stations and {len(clues)} clues")


if __name__ == "__main__":
    main()

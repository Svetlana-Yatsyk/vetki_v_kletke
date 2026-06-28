#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

DEFAULT_SOURCE = Path("public/data/attributes.csv")
DEFAULT_OUTPUT = Path("public/data/game-data.json")
MIN_CELL_ANSWER_COUNT = 3
STATION_FIELDS = {
    "station_id",
    "station_group_id",
    "name_ru",
    "name_en",
    "line_id",
    "line_name_ru",
    "line_name_en",
}
LETTER_LABELS = {
    "a": "а",
    "be": "б",
    "ve": "в",
    "ge": "г",
    "de": "д",
    "e": "е",
    "yo": "ё",
    "zhe": "ж",
    "ze": "з",
    "i": "и",
    "short_i": "й",
    "ka": "к",
    "el": "л",
    "em": "м",
    "en": "н",
    "o": "о",
    "pe": "п",
    "er": "р",
    "es": "с",
    "te": "т",
    "u": "у",
    "ef": "ф",
    "ha": "х",
    "tse": "ц",
    "che": "ч",
    "sha": "ш",
    "shcha": "щ",
    "y": "ы",
    "soft_sign": "ь",
    "e_reverse": "э",
    "yu": "ю",
    "ya": "я",
}
ATTRIBUTE_LABELS = {
    "starts_with_vowel": ("Начинается на гласную", "name"),
    "starts_with_consonant": ("Начинается на согласную", "name"),
    "ends_with_vowel": ("Заканчивается на гласную", "name"),
    "ends_with_consonant": ("Заканчивается на согласную", "name"),
    "starts_and_ends_same_letter": ("Начинается и заканчивается на одну букву", "name"),
    "contains_soft_sign": ("В названии есть мягкий знак", "name"),
    "contains_yo": ("В названии есть буква ё", "name"),
    "contains_hyphen": ("В названии есть дефис", "name"),
    "word_count_1": ("Название из одного слова", "name"),
    "word_count_2": ("Название из двух слов", "name"),
    "word_count_3": ("Название из трех слов", "name"),
    "contains_name": ("В названии есть имя", "name"),
    "contains_street": ("В названии есть улица", "name"),
    "contains_avenue": ("В названии есть проспект", "name"),
    "contains_boulevard": ("В названии есть бульвар", "name"),
    "contains_square": ("В названии есть площадь", "name"),
    "contains_park": ("В названии есть парк", "name"),
    "is_transfer_station": ("Есть пересадка", "transfer"),
    "is_non_transfer_station": ("Без пересадки", "transfer"),
    "has_mcc_transfer": ("Есть пересадка на МЦК", "transfer"),
    "has_koltsevaya_transfer": ("Есть пересадка на Кольцевую линию", "transfer"),
    "has_big_circle_line_transfer": ("Есть пересадка на БКЛ", "transfer"),
    "same_name_station_group": ("Название повторяется на нескольких линиях", "station_group"),
    "single_line_station_group": ("Название встречается на одной линии", "station_group"),
    "opened_before_1950": ("Открыта до 1950 года", "opened"),
    "opened_1950s": ("Открыта в 1950-е", "opened"),
    "opened_1960s": ("Открыта в 1960-е", "opened"),
    "opened_1970s": ("Открыта в 1970-е", "opened"),
    "opened_1980s": ("Открыта в 1980-е", "opened"),
    "opened_1990s": ("Открыта в 1990-е", "opened"),
    "opened_2000s": ("Открыта в 2000-е", "opened"),
    "opened_2010s": ("Открыта в 2010-е", "opened"),
    "opened_2020s": ("Открыта в 2020-е", "opened"),
    "opened_soviet_era": ("Открыта в советское время", "opened"),
    "opened_post_soviet": ("Открыта после 1991 года", "opened"),
    "opened_21st_century": ("Открыта в XXI веке", "opened"),
    "opened_after_2010": ("Открыта после 2010 года", "opened"),
    "opened_after_2020": ("Открыта после 2020 года", "opened"),
    "shallow_station": ("Станция мелкого заложения", "depth"),
    "surface_or_ground_level_station": ("Наземная или поверхностная станция", "depth"),
    "station_type_column_double_span": ("Колонная двухпролетная станция", "station_type"),
    "station_type_column_triple_span": ("Колонная трехпролетная станция", "station_type"),
    "station_type_column_triple_vault": ("Колонная трехсводчатая станция", "station_type"),
    "station_type_elevated": ("Эстакадная станция", "station_type"),
    "station_type_elevated_open": ("Открытая эстакадная станция", "station_type"),
    "station_type_pylon_triple_vault": ("Пилонная трехсводчатая станция", "station_type"),
    "station_type_single_vault_shallow": ("Односводчатая станция мелкого заложения", "station_type"),
    "station_type_surface": ("Наземная станция", "station_type"),
    "station_type_surface_open": ("Открытая наземная станция", "station_type"),
    "has_fossils": ("На станции есть окаменелости", "misc"),
}


def normalize(value: Any) -> str:
    text = str(value or "").strip().lower().replace("ё", "е")
    normalized = []
    last_was_space = True
    for char in text:
        if "а" <= char <= "я" or "a" <= char <= "z" or char.isdigit():
            normalized.append(char)
            last_was_space = False
        elif not last_was_space:
            normalized.append(" ")
            last_was_space = True
    return "".join(normalized).strip()


def parse_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def attribute_columns(rows: list[dict[str, str]]) -> list[str]:
    if not rows:
        return []
    return [column for column in rows[0] if column not in STATION_FIELDS]


def station_tags(row: dict[str, str], attributes: list[str]) -> list[str]:
    return [f"attr:{attribute}" for attribute in attributes if parse_bool(row.get(attribute))]


def build_station(row: dict[str, str], attributes: list[str]) -> dict[str, Any]:
    station_id = row.get("station_id") or f"{normalize(row.get('name_ru'))}:{row.get('line_id')}"
    return {
        "id": station_id,
        "groupId": row.get("station_group_id") or station_id,
        "nameRu": row.get("name_ru", ""),
        "nameEn": row.get("name_en", ""),
        "lineId": str(row.get("line_id", "")).strip(),
        "lineNameRu": row.get("line_name_ru", ""),
        "lineNameEn": row.get("line_name_en", ""),
        "lineColor": "",
        "tags": station_tags(row, attributes),
        "searchText": normalize(" ".join([row.get("name_ru", ""), row.get("name_en", ""), row.get("line_name_ru", "")])),
    }


def line_labels(rows: list[dict[str, str]], attributes: list[str]) -> dict[str, str]:
    labels: dict[str, str] = {}
    line_attributes = [attribute for attribute in attributes if attribute.startswith("line_")]
    for row in rows:
        line_name = row.get("line_name_ru", "").strip()
        if not line_name:
            continue
        for attribute in line_attributes:
            if parse_bool(row.get(attribute)):
                labels.setdefault(attribute, line_name)
    return labels


def attribute_label(attribute: str, line_names: dict[str, str]) -> tuple[str, str] | None:
    if attribute in line_names:
        return line_names[attribute], "line"
    if attribute.startswith("contains_letter_"):
        letter_key = attribute.removeprefix("contains_letter_")
        letter = LETTER_LABELS.get(letter_key)
        if letter:
            return f"В названии есть буква {letter}", "letter"
    return ATTRIBUTE_LABELS.get(attribute)


def base_clues(rows: list[dict[str, str]], attributes: list[str]) -> list[dict[str, str]]:
    names = line_labels(rows, attributes)
    clues = []
    for attribute in attributes:
        label = attribute_label(attribute, names)
        if not label:
            continue
        clue_label, group = label
        clues.append({"id": f"attr:{attribute}", "attribute": attribute, "label": clue_label, "group": group})
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

    attributes = attribute_columns(rows)
    stations = [build_station(row, attributes) for row in rows if row.get("name_ru") and row.get("line_id")]
    clues = base_clues(rows, attributes)

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
            "minCellAnswerCount": MIN_CELL_ANSWER_COUNT,
        },
        "stations": stations,
        "clues": clues,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {args.output} with {len(stations)} stations and {len(clues)} clues")


if __name__ == "__main__":
    main()

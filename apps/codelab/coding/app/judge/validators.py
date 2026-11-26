"""Semantic output validators shared by the CLI and local web service."""

from __future__ import annotations

from collections import Counter


def comparable_text(text: str) -> str:
    return " ".join(text.split())


def _parse_ints(text: str) -> list[int] | None:
    try:
        return list(map(int, text.split()))
    except ValueError:
        return None


def valid_top_k_frequent(stdin: str, actual: str) -> bool:
    try:
        tokens = list(map(int, stdin.split()))
        count = tokens[0]
        values = tokens[1 : count + 1]
        requested = tokens[count + 1]
        answer = list(map(int, actual.split()))
    except (IndexError, ValueError):
        return False
    frequencies = Counter(values)
    if not 1 <= requested <= len(frequencies):
        return False
    if len(answer) != requested or len(set(answer)) != requested or answer != sorted(answer):
        return False
    cutoff = sorted(frequencies.values(), reverse=True)[requested - 1]
    required = {value for value, frequency in frequencies.items() if frequency > cutoff}
    allowed = {value for value, frequency in frequencies.items() if frequency >= cutoff}
    return required <= set(answer) <= allowed


def valid_k_closest(stdin: str, actual: str) -> bool:
    try:
        values = list(map(int, stdin.split()))
        count = values[0]
        end = 1 + 2 * count
        points = [(values[index], values[index + 1]) for index in range(1, end, 2)]
        requested = values[end]
        output = list(map(int, actual.split()))
    except (IndexError, ValueError):
        return False
    if len(output) != 2 * requested:
        return False
    selected = [(output[index], output[index + 1]) for index in range(0, len(output), 2)]
    available = Counter(points)
    selected_counts = Counter(selected)
    if any(amount > available[point] for point, amount in selected_counts.items()):
        return False
    distance = lambda point: point[0] * point[0] + point[1] * point[1]
    cutoff = sorted(map(distance, points))[requested - 1]
    required = Counter(point for point in points if distance(point) < cutoff)
    return all(distance(point) <= cutoff for point in selected) and all(
        selected_counts[point] >= amount for point, amount in required.items()
    )


def valid_k_pairs(stdin: str, actual: str) -> bool:
    tokens = _parse_ints(stdin)
    answer = _parse_ints(actual)
    if tokens is None or answer is None:
        return False
    left_size, right_size, requested = tokens[:3]
    left = tokens[3 : 3 + left_size]
    right = tokens[3 + left_size : 3 + left_size + right_size]
    requested = min(requested, left_size * right_size)
    if len(answer) != requested * 2:
        return False
    selected = [(answer[index], answer[index + 1]) for index in range(0, len(answer), 2)]
    available = Counter((a, b) for a in left for b in right)
    selected_counts = Counter(selected)
    if any(amount > available[pair] for pair, amount in selected_counts.items()):
        return False
    cutoff = sorted(a + b for a in left for b in right)[requested - 1]
    required = Counter((a, b) for a in left for b in right if a + b < cutoff)
    return all(selected_counts[pair] >= amount for pair, amount in required.items()) and all(
        a + b <= cutoff for a, b in selected
    )


def valid_reorganization(stdin: str, actual: str) -> bool:
    source = stdin.strip()
    result = actual.strip()
    possible = max(Counter(source).values()) <= (len(source) + 1) // 2
    if result == "IMPOSSIBLE":
        return not possible
    return possible and Counter(result) == Counter(source) and all(
        result[index] != result[index - 1] for index in range(1, len(result))
    )


def valid_frequency_string(stdin: str, actual: str) -> bool:
    source = stdin.rstrip("\n")
    result = actual.strip()
    if Counter(source) != Counter(result):
        return False
    sizes: list[int] = []
    seen: set[str] = set()
    index = 0
    while index < len(result):
        character = result[index]
        if character in seen:
            return False
        seen.add(character)
        end = index + 1
        while end < len(result) and result[end] == character:
            end += 1
        sizes.append(end - index)
        index = end
    return sizes == sorted(sizes, reverse=True)


VALIDATORS = {
    "top_k_frequent": valid_top_k_frequent,
    "k_closest": valid_k_closest,
    "heap_k_pairs": valid_k_pairs,
    "heap_reorganization": valid_reorganization,
    "bucket_frequency_string": valid_frequency_string,
}


def output_matches(validator: str | None, stdin: str, actual: str, expected: str) -> bool:
    if validator:
        return VALIDATORS[validator](stdin, actual)
    return comparable_text(actual) == comparable_text(expected)

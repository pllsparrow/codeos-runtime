#!/usr/bin/env python3
"""Deterministic cases for the staged prefix-sum training collection."""

from __future__ import annotations

import bisect
import random
from collections import defaultdict, deque
from dataclasses import dataclass


@dataclass(frozen=True)
class Case:
    stdin: str
    expected: str
    size: int
    category: str


EXERCISES = {
    "p01": "Static Range Sum Queries",
    "p02": "Range Addition Reconstruction",
    "p03": "Count Subarrays With Target Sum",
    "p04": "Longest Subarray With Target Sum",
    "p05": "Two-Dimensional Range Sum Queries",
    "p06": "Count Target Sum Submatrices",
    "p07": "Maximum Rectangle Sum No Larger Than Limit",
    "p08": "Shortest Subarray With Sum At Least Limit",
    "p09": "Weighted Farmland Rectangle",
}


def _ints(values) -> str:
    return " ".join(map(str, values))


def _count_target_subarrays(values: list[int], target: int) -> int:
    prefix_counts = defaultdict(int, {0: 1})
    prefix = 0
    answer = 0
    for value in values:
        prefix += value
        answer += prefix_counts[prefix - target]
        prefix_counts[prefix] += 1
    return answer


def _longest_target_subarray(values: list[int], target: int) -> int:
    first_index = {0: 0}
    prefix = 0
    answer = 0
    for right, value in enumerate(values, start=1):
        prefix += value
        if prefix - target in first_index:
            answer = max(answer, right - first_index[prefix - target])
        first_index.setdefault(prefix, right)
    return answer


def _matrix_prefix(matrix: list[list[int]]) -> list[list[int]]:
    rows = len(matrix)
    cols = len(matrix[0])
    prefix = [[0] * (cols + 1) for _ in range(rows + 1)]
    for row in range(1, rows + 1):
        for col in range(1, cols + 1):
            prefix[row][col] = (
                matrix[row - 1][col - 1]
                + prefix[row - 1][col]
                + prefix[row][col - 1]
                - prefix[row - 1][col - 1]
            )
    return prefix


def _rectangle_sum(
    prefix: list[list[int]],
    top: int,
    bottom: int,
    left: int,
    right: int,
) -> int:
    return (
        prefix[bottom][right]
        - prefix[top][right]
        - prefix[bottom][left]
        + prefix[top][left]
    )


def _count_target_submatrices(matrix: list[list[int]], target: int) -> int:
    rows = len(matrix)
    cols = len(matrix[0])
    answer = 0
    for top in range(rows):
        column_sums = [0] * cols
        for bottom in range(top, rows):
            for col in range(cols):
                column_sums[col] += matrix[bottom][col]
            answer += _count_target_subarrays(column_sums, target)
    return answer


def _maximum_rectangle_no_larger_than(
    matrix: list[list[int]],
    limit: int,
) -> int:
    rows = len(matrix)
    cols = len(matrix[0])
    answer: int | None = None
    for top in range(rows):
        column_sums = [0] * cols
        for bottom in range(top, rows):
            for col in range(cols):
                column_sums[col] += matrix[bottom][col]
            ordered_prefixes = [0]
            prefix = 0
            for value in column_sums:
                prefix += value
                index = bisect.bisect_left(ordered_prefixes, prefix - limit)
                if index < len(ordered_prefixes):
                    candidate = prefix - ordered_prefixes[index]
                    answer = candidate if answer is None else max(answer, candidate)
                bisect.insort(ordered_prefixes, prefix)
    if answer is None:
        raise ValueError("Every generated case must contain a qualifying rectangle")
    return answer


def _shortest_subarray_at_least(values: list[int], limit: int) -> int:
    prefix = [0]
    for value in values:
        prefix.append(prefix[-1] + value)
    candidates: deque[int] = deque()
    answer = len(values) + 1
    for right, current in enumerate(prefix):
        while candidates and current - prefix[candidates[0]] >= limit:
            answer = min(answer, right - candidates.popleft())
        while candidates and prefix[candidates[-1]] >= current:
            candidates.pop()
        candidates.append(right)
    return -1 if answer == len(values) + 1 else answer


def _weighted_farmland(matrix: list[list[int]]) -> int:
    rows = len(matrix)
    cols = len(matrix[0])
    prefix = _matrix_prefix(matrix)
    answer = -10**30
    for top in range(rows):
        for bottom in range(top + 1, rows + 1):
            for left in range(cols):
                for right in range(left + 1, cols + 1):
                    total = _rectangle_sum(prefix, top, bottom, left, right)
                    answer = max(
                        answer,
                        min(bottom - top, right - left) * total,
                    )
    return answer


def _build_p01() -> list[Case]:
    rng = random.Random(3101)
    cases = []
    for index in range(49):
        size = 1 if index == 0 else 20 + index * 7
        values = [rng.randint(-100, 100) for _ in range(size)]
        query_count = 1 if index == 0 else 20 + index * 3
        queries = []
        for _ in range(query_count):
            left = rng.randrange(size)
            right = rng.randrange(left + 1, size + 1)
            queries.append((left, right))
        stdin = f"{size} {query_count}\n{_ints(values)}\n" + "".join(
            f"{left} {right}\n" for left, right in queries
        )
        expected = "".join(f"{sum(values[left:right])}\n" for left, right in queries)
        cases.append(Case(stdin, expected, size + query_count, "half-open interval boundaries"))
    return cases


def _build_p02() -> list[Case]:
    rng = random.Random(3102)
    cases = []
    for index in range(49):
        size = 1 if index == 0 else 25 + index * 6
        values = [rng.randint(-40, 40) for _ in range(size)]
        query_count = 1 if index == 0 else 15 + index * 2
        updates = []
        answer = values[:]
        for _ in range(query_count):
            left = rng.randrange(size)
            right = rng.randrange(left + 1, size + 1)
            delta = rng.randint(-20, 20)
            updates.append((left, right, delta))
            for position in range(left, right):
                answer[position] += delta
        stdin = f"{size} {query_count}\n{_ints(values)}\n" + "".join(
            f"{left} {right} {delta}\n" for left, right, delta in updates
        )
        cases.append(Case(stdin, _ints(answer) + "\n", size + query_count, "difference boundaries and reconstruction"))
    return cases


def _build_p03() -> list[Case]:
    rng = random.Random(3103)
    cases = []
    for index in range(49):
        size = 1 if index == 0 else 60 + index * 18
        values = [rng.randint(-12, 12) for _ in range(size)]
        target = rng.randint(-25, 25)
        stdin = f"{size} {target}\n{_ints(values)}\n"
        answer = _count_target_subarrays(values, target)
        cases.append(Case(stdin, f"{answer}\n", size, "negative values and repeated prefixes"))
    return cases


def _build_p04() -> list[Case]:
    rng = random.Random(3104)
    cases = []
    for index in range(49):
        size = 1 if index == 0 else 70 + index * 17
        values = [rng.randint(-15, 15) for _ in range(size)]
        target = rng.randint(-30, 30)
        stdin = f"{size} {target}\n{_ints(values)}\n"
        answer = _longest_target_subarray(values, target)
        cases.append(Case(stdin, f"{answer}\n", size, "earliest prefix index and missing answers"))
    return cases


def _build_p05() -> list[Case]:
    rng = random.Random(3105)
    cases = []
    for index in range(49):
        rows = 1 + index % 12
        cols = 1 + (index * 3) % 14
        matrix = [[rng.randint(-30, 30) for _ in range(cols)] for _ in range(rows)]
        prefix = _matrix_prefix(matrix)
        query_count = 1 if index == 0 else 25 + index * 2
        queries = []
        for _ in range(query_count):
            top = rng.randrange(rows)
            bottom = rng.randrange(top + 1, rows + 1)
            left = rng.randrange(cols)
            right = rng.randrange(left + 1, cols + 1)
            queries.append((top, bottom, left, right))
        stdin = f"{rows} {cols} {query_count}\n" + "".join(
            _ints(row) + "\n" for row in matrix
        ) + "".join(
            f"{top} {bottom} {left} {right}\n"
            for top, bottom, left, right in queries
        )
        expected = "".join(
            f"{_rectangle_sum(prefix, top, bottom, left, right)}\n"
            for top, bottom, left, right in queries
        )
        cases.append(Case(stdin, expected, rows * cols + query_count, "2-D half-open rectangle boundaries"))
    return cases


def _build_p06() -> list[Case]:
    rng = random.Random(3106)
    cases = []
    for index in range(49):
        rows = 1 + index % 9
        cols = 1 + (index * 2) % 11
        matrix = [[rng.randint(-5, 5) for _ in range(cols)] for _ in range(rows)]
        target = rng.randint(-10, 10)
        stdin = f"{rows} {cols} {target}\n" + "".join(
            _ints(row) + "\n" for row in matrix
        )
        answer = _count_target_submatrices(matrix, target)
        cases.append(Case(stdin, f"{answer}\n", rows * cols, "row-band compression and prefix frequencies"))
    return cases


def _build_p07() -> list[Case]:
    rng = random.Random(3107)
    cases = []
    for index in range(49):
        rows = 1 + index % 8
        cols = 1 + (index * 3) % 10
        matrix = [[rng.randint(-8, 8) for _ in range(cols)] for _ in range(rows)]
        minimum_cell = min(map(min, matrix))
        limit = rng.randint(minimum_cell, 18)
        stdin = f"{rows} {cols} {limit}\n" + "".join(
            _ints(row) + "\n" for row in matrix
        )
        answer = _maximum_rectangle_no_larger_than(matrix, limit)
        cases.append(Case(stdin, f"{answer}\n", rows * cols, "ordered prefixes and negative values"))
    return cases


def _build_p08() -> list[Case]:
    rng = random.Random(3108)
    cases = []
    for index in range(49):
        size = 1 if index == 0 else 80 + index * 20
        values = [rng.randint(-25, 35) for _ in range(size)]
        limit = 1 + index * 7
        stdin = f"{size} {limit}\n{_ints(values)}\n"
        answer = _shortest_subarray_at_least(values, limit)
        cases.append(Case(stdin, f"{answer}\n", size, "negative values and monotonic prefix candidates"))
    return cases


def _build_p09() -> list[Case]:
    rng = random.Random(3109)
    cases = []
    for index in range(49):
        rows = 1 + index % 7
        cols = 1 + (index * 2) % 9
        matrix = [[rng.randint(-9, 12) for _ in range(cols)] for _ in range(rows)]
        stdin = f"{rows} {cols}\n" + "".join(_ints(row) + "\n" for row in matrix)
        answer = _weighted_farmland(matrix)
        cases.append(Case(stdin, f"{answer}\n", rows * cols, "short-side split and constrained band sums"))
    return cases


BUILDERS = {
    "p01": _build_p01,
    "p02": _build_p02,
    "p03": _build_p03,
    "p04": _build_p04,
    "p05": _build_p05,
    "p06": _build_p06,
    "p07": _build_p07,
    "p08": _build_p08,
    "p09": _build_p09,
}


def build_cases(exercise_id: str) -> list[Case]:
    cases = BUILDERS[exercise_id]()
    if len(cases) != 49:
        raise ValueError(f"{exercise_id} generated {len(cases)} cases instead of 49")
    if len({case.stdin for case in cases}) != len(cases):
        raise ValueError(f"{exercise_id} generated duplicate stdin payloads")
    return cases

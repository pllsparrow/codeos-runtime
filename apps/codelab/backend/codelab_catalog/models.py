from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


CellType = Literal["markdown", "code", "raw"]
ResourceKind = Literal["markdown", "notebook"]
ResourceRole = Literal["hub", "concept", "experiment", "practice", "review", "resource"]


@dataclass(frozen=True)
class NotebookCell:
    cell_type: CellType
    source: str
    execution_count: int | None
    output_count: int


@dataclass(frozen=True)
class NotebookSummary:
    path: str
    title: str
    language: str | None
    cells: tuple[NotebookCell, ...]

    @property
    def code_cell_count(self) -> int:
        return sum(cell.cell_type == "code" for cell in self.cells)

    @property
    def markdown_cell_count(self) -> int:
        return sum(cell.cell_type == "markdown" for cell in self.cells)

    @property
    def output_count(self) -> int:
        return sum(cell.output_count for cell in self.cells)


@dataclass(frozen=True)
class CatalogResource:
    path: str
    title: str
    kind: ResourceKind
    notebook: NotebookSummary | None = None
    role: ResourceRole | None = None


@dataclass(frozen=True)
class LearningChapter:
    id: str
    title: str
    track_id: str
    track_title: str
    hub_path: str
    resources: tuple[CatalogResource, ...]

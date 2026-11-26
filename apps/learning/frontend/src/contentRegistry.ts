import {
  readingCourses,
  teachingNoteIds,
  supplementalReferenceIds,
  courseForNote,
  type ReadingCourse,
} from "./courseCatalog";
import {
  knowledgeTopics,
  knowledgeReferenceIds,
  topicForNote,
  installTopics,
  type KnowledgeTopic,
} from "./knowledgeTopics";
export type ContentRole = "notes" | "plans" | "knowledge" | "courses" | "reviews";
export type PracticeLesson = {
  id: string;
  title: string;
  objective: string;
  stage: string;
  reading_note_id: number | null;
  experiment_plan: string[];
  experiment_setup: string;
};
export type CollectionBody = {
  path_id?: string;
  subject?: "algorithms" | "sql";
  path_base?: { revision: number; lessons: Record<string, string> } | null;
  lessons?: PracticeLesson[];
  title: string;
  description: string;
  track: "python" | "go" | "backend" | "ai";
  practice?: string;
  kind?: "Project" | "Learning plan";
  overview?: number;
  entries: { noteId: number; title: string }[];
  courses?: string[];
  notes?: number[];
  archived?: boolean;
};
export type Collection = {
  id: string;
  kind: "knowledge" | "courses";
  slug: string;
  draft?: CollectionBody | null;
  published: CollectionBody | null;
  version: number;
};
export const reviewNoteIds = new Set<number>();
export const planNoteIds = new Set<number>();
export const reviewDetails = new Map<
  number,
  { company: string; provenance: string }
>();
export type DocumentMeta = {
  display_title?: string | null;
  review_company?: string | null;
  review_provenance?: string | null;
  note_id: number;
  title: string;
  kind: ContentRole | "reference";
  collection_id: string | null;
  updated_at: string;
  deleted_at: string | null;
};
export type DraftMeta = {
  review_company?: string;
  review_provenance?: string;
  id: string;
  note_id: number | null;
  kind: ContentRole;
  collection_id: string | null;
  title: string;
  version: number;
  updated_at: string;
};
export type ContentCatalog = {
  collections: Collection[];
  documents: DocumentMeta[];
  drafts: DraftMeta[];
};
export async function contentRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api/codelab/learning" + path, {
    ...options,
    cache: options.cache || "no-store",
    signal: options.signal || AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : Array.isArray(body.detail)
          ? body.detail
              .map((item: { msg?: string }) => item.msg || "Invalid input")
              .join("; ")
          : `Content request failed (${response.status})`,
    );
  return body;
}
export function installCatalog(catalog: ContentCatalog) {
  if (!Array.isArray(catalog.collections) || !Array.isArray(catalog.documents))
    throw new Error("Unexpected content catalog");
  const live = catalog.collections.filter(
    (c) => c.published && !c.published.archived,
  );
  const courses: ReadingCourse[] = live
    .filter((c) => c.kind === "courses" && !c.published?.path_id)
    .map((c) => ({
      ...c.published!,
      id: c.slug,
      readings: c.published!.entries,
      practice: c.published!.practice || "Independent practice",
    }));
  readingCourses.splice(0, readingCourses.length, ...courses);
  const topics: KnowledgeTopic[] = live
    .filter((c) => c.kind === "knowledge")
    .map((c) => ({
      ...c.published!,
      id: c.slug,
      courses: c.published!.courses || [],
      personalNoteIds: c.published!.notes || [],
    }));
  installTopics(
    topics,
    Object.fromEntries(
      live
        .filter((c) => c.kind === "knowledge")
        .map((c) => [c.slug, c.published!.entries]),
    ),
  );
  reviewNoteIds.clear();
  planNoteIds.clear();
  reviewDetails.clear();
  teachingNoteIds.clear();
  supplementalReferenceIds.clear();
  knowledgeReferenceIds.clear();
  for (const d of catalog.documents) {
    if (d.kind === "plans") planNoteIds.add(d.note_id);
    if (d.kind === "reviews") {
      reviewNoteIds.add(d.note_id);
      reviewDetails.set(d.note_id, {
        company: d.review_company || "",
        provenance: d.review_provenance || "unknown",
      });
    }
    if (d.kind === "courses") teachingNoteIds.add(d.note_id);
    if (d.kind === "reference") supplementalReferenceIds.add(d.note_id);
    if (d.kind === "knowledge") knowledgeReferenceIds.add(d.note_id);
  }
}
export const loadContentRegistry = async () =>
  installCatalog(await contentRequest<ContentCatalog>("/content/catalog"));
export function readerHref(id: number): string {
  if (reviewNoteIds.has(id) || planNoteIds.has(id)) return `/learning/read/${id}`;
  const course = courseForNote(id),
    topic = topicForNote(id);
  return topic
    ? `/learning/knowledge/articles/${id}`
    : course
      ? `/learning/courses/${course.id}/lessons/${id}`
      : teachingNoteIds.has(id) || supplementalReferenceIds.has(id)
        ? `/learning/read/${id}`
        : `/learning/knowledge/notes/${id}`;
}
export function canonicalContentHref(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return href;
    const pathname = url.pathname.replace(/\/$/, "");
    const id = Number(url.searchParams.get("note"));
    const suffix = () => {
      for (const key of ["note", "topic", "course", "new"])
        url.searchParams.delete(key);
      const query = url.searchParams.toString();
      return (query ? "?" + query : "") + url.hash;
    };
    if (pathname === "/learning/notes/write") {
      return (
        (id > 0
          ? `/writing/${reviewNoteIds.has(id) ? "reviews" : planNoteIds.has(id) ? "plans" : knowledgeReferenceIds.has(id) ? "knowledge" : teachingNoteIds.has(id) ? "courses" : "notes"}/${id}`
          : "/writing/notes/new") + suffix()
      );
    }
    if (["/learning/notes", "/learning/library"].includes(pathname)) {
      if (id > 0) return readerHref(id) + suffix();
      const topic = url.searchParams.get("topic");
      return topic && knowledgeTopics.some((row) => row.id === topic)
        ? "/learning/knowledge/topics/" + topic
        : "/learning/knowledge/";
    }
    return href;
  } catch {
    return href;
  }
}

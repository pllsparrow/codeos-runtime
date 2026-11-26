import { useEffect, useRef, useState } from "react";
import { studyRequest } from "./StudyCoverage";
import { requestId } from "./requestId";
import type { PathSummary } from "./learningSubjects";
import type { ContentRole } from "./contentRegistry";

type Lesson = {
  id: string;
  title: string;
  reading_note_id: number | null;
  updated_at: string;
};
type Link = { note_id: number; updated_at: string };
export default function WritingConnections({
  noteId,
  role,
}: {
  noteId: number;
  role: ContentRole;
}) {
  const [paths, setPaths] = useState<PathSummary[]>([]);
  const [lessons, setLessons] = useState<Record<string, Lesson>>({});
  const [links, setLinks] = useState<Record<string, Link[]>>({});
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    setLoaded(false);
    setPaths([]);
    setError("");
  }, [noteId, role]);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const catalog = await studyRequest<PathSummary[]>("");
      const rows = await Promise.all(
        catalog
          .flatMap((path) => path.lessons)
          .map(async (lesson) => ({
            id: lesson.id,
            lesson: await studyRequest<Lesson>("/lessons/" + lesson.id),
            notes:
              role === "notes"
                ? await studyRequest<Link[]>("/lessons/" + lesson.id + "/notes")
                : [],
          })),
      );
      setPaths(catalog);
      setLessons(Object.fromEntries(rows.map((row) => [row.id, row.lesson])));
      setLinks(Object.fromEntries(rows.map((row) => [row.id, row.notes])));
      setLoaded(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const change = async (id: string) => {
    setBusy(true);
    setError("");
    const old = links[id]?.find((row) => row.note_id === noteId);
    const payload =
      role === "notes"
        ? {
            note_id: noteId,
            remove: Boolean(old),
            expected_version: old?.updated_at || null,
          }
        : { note_id: noteId, expected_version: lessons[id].updated_at };
    const signature = JSON.stringify({ id, payload });
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: requestId() };
    try {
      await studyRequest(
        "/lessons/" + id + (role === "notes" ? "/notes" : "/reading"),
        {
          method: "POST",
          headers: { "Idempotency-Key": pending.current.key },
          body: JSON.stringify(payload),
        },
      );
      if (role === "notes") {
        const read = await studyRequest<Link[]>("/lessons/" + id + "/notes");
        if (read.some((row) => row.note_id === noteId) === Boolean(old))
          throw Error("Association read-back failed. Retry without leaving.");
        setLinks((current) => ({ ...current, [id]: read }));
      } else {
        const read = await studyRequest<Lesson>("/lessons/" + id);
        if (read.reading_note_id !== noteId)
          throw Error("Reading association could not be confirmed.");
        setLessons((current) => ({ ...current, [id]: read }));
      }
      pending.current = null;
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (role === "knowledge" || role === "reviews") return null;
  return (
    <details
      className="writing-connections"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary>
        {role === "notes"
          ? "Link this personal Note to course lessons"
          : "Manage active-practice reading associations"}
      </summary>
      {busy && <p role="status">Loading / saving associations…</p>}
      {error && (
        <p role="alert">
          {error}
          <button disabled={busy} onClick={() => void load()}>
            Reload associations
          </button>
        </p>
      )}
      {paths.map((path) => (
        <section key={path.id}>
          <h3>{path.title}</h3>
          <div className="writing-related-choices">
            {path.lessons.map((lesson) => {
              const selected =
                role === "notes"
                  ? links[lesson.id]?.some((row) => row.note_id === noteId)
                  : lessons[lesson.id]?.reading_note_id === noteId;
              return (
                <button
                  key={lesson.id}
                  disabled={busy || (role !== "notes" && selected)}
                  aria-pressed={selected}
                  onClick={() => void change(lesson.id)}
                >
                  {lesson.title}
                  {selected ? " · Linked" : ""}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {loaded && !paths.length && (
        <p>No active-practice courses are available.</p>
      )}
    </details>
  );
}

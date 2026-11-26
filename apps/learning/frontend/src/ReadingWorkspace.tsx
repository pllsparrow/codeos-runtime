import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen } from "lucide-react";
import NotesMarkdown from "./NotesMarkdown";
import CourseStudyPrompt from "./CourseStudyPrompt";
import PersonalNoteContext from "./PersonalNoteContext";
import LessonContext from "./LessonContext";
import { courseForNote, courseNoteOrder } from "./courseCatalog";
import { topicForNote, topicReadings } from "./knowledgeTopics";
import { notesRequest, type Catalog, type Note } from "./notesClient";
import { planNoteIds, readerHref, reviewDetails } from "./contentRegistry";
import "./readingWorkspace.css";
export default function ReadingWorkspace({ noteId }: { noteId: number }) {
  const [note, setNote] = useState<Note | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNote(null);
    void Promise.all([
      notesRequest<Note>("/notes/" + noteId, { signal: controller.signal }),
      notesRequest<Catalog>("", { signal: controller.signal }),
    ])
      .then(([body, list]) => {
        if (body.deleted_at)
          throw Error(
            "This document is archived. Choose another published reading.",
          );
        if (!controller.signal.aborted) {
          setNote(body);
          setCatalog(list);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [noteId, revision]);
  const review = reviewDetails.get(noteId);
  const isPlan = planNoteIds.has(noteId);
  const course = courseForNote(noteId),
    topic = topicForNote(noteId);
  const available = new Set(
    (catalog?.notes || []).filter((n) => !n.deleted_at).map((n) => n.id),
  );
  const entries = course
    ? courseNoteOrder(course).map((id) => ({
        noteId: id,
        title:
          id === course.overview
            ? "Course introduction"
            : course.readings.find((r) => r.noteId === id)?.title || "Reading",
      }))
    : topic
      ? topicReadings(topic)
      : [];
  const returnHref = course
    ? "/learning/courses/" + course.id
    : topic
      ? "/learning/knowledge/topics/" + topic.id
      : isPlan ? "/learning/knowledge/?view=plans" : "/learning/knowledge/";
  return (
    <main className="reading-workspace">
      <aside className="reading-navigation">
        <a className="reading-back" href={returnHref}>
          <ArrowLeft size={16} />
          {course?.title || topic?.title || (isPlan ? "Learning plans" : "Knowledge")}
        </a>
        <span className="reading-eyebrow">
          {course
            ? "COURSE SYLLABUS"
            : topic
              ? "CONCEPT MODEL"
              : isPlan ? "LEARNING PLAN" : "PERSONAL UNDERSTANDING"}
        </span>
        <p>
          {course
            ? "Reason about the question. Build, observe and revise your explanation."
            : topic
              ? "Connect the parts, trace the mechanism and test the boundaries."
              : isPlan ? "Review your goals, timeline and next steps." : "Revisit your own explanation and its connections."}
        </p>
        <nav aria-label={course ? "Course navigation" : "Knowledge navigation"}>
          {entries
            .filter((r) => available.has(r.noteId) || r.noteId === noteId)
            .map((entry, index) => (
              <a
                key={entry.noteId}
                aria-current={entry.noteId === noteId ? "page" : undefined}
                href={readerHref(entry.noteId)}
              >
                {course && <small>{String(index + 1).padStart(2, "0")}</small>}
                <span>{entry.title}</span>
              </a>
            ))}
        </nav>
        <a
          className="reading-library-link"
          href={course ? "/learning/" : "/learning/knowledge/"}
        >
          <BookOpen size={15} />
          {course ? "All courses" : "All knowledge topics"}
        </a>
        <LessonContext canLeave={() => true} />
      </aside>
      <section className="reading-content">
        {loading ? (
          <p role="status">Loading published reading…</p>
        ) : error ? (
          <div className="reading-error" role="alert">
            <h1>Reading unavailable</h1>
            <p>{error}</p>
            <button onClick={() => retry((v) => v + 1)}>Retry reading</button>
            <a href={returnHref}>Choose another document</a>
          </div>
        ) : (
          note && (
            <>
              <NotesMarkdown
                content={note.content}
                header={
                  <>
                    <header className="reading-document-header">
                      <span>
                        {course
                          ? "Guided course reading"
                          : topic
                            ? "Concept reference"
                            : review
                              ? "Interview & exam review"
                              : isPlan ? "Learning plan" : "Personal note"}{" "}
                        · Published
                      </span>
                      <time dateTime={note.updated_at}>
                        {new Date(note.updated_at).toLocaleDateString()}
                      </time>
                    </header>
                    {course && (
                      <CourseStudyPrompt course={course} noteId={noteId} />
                    )}
                  </>
                }
              />
              <PersonalNoteContext noteId={note.id} />
            </>
          )
        )}
      </section>
    </main>
  );
}

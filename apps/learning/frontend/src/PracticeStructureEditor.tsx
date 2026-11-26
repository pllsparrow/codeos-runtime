import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  CollectionBody,
  DocumentMeta,
  PracticeLesson,
} from "./contentRegistry";
import { requestId } from "./requestId";

export default function PracticeStructureEditor({
  value,
  disabled,
  documents,
  onChange,
}: {
  value: CollectionBody;
  disabled: boolean;
  documents: DocumentMeta[];
  onChange: (value: CollectionBody) => void;
}) {
  const [query, setQuery] = useState("");
  const lessons = value.lessons || [];
  const update = (id: string, patch: Partial<PracticeLesson>) =>
    onChange({
      ...value,
      lessons: lessons.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    });
  const move = (index: number, step: number) => {
    const next = [...lessons];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    onChange({ ...value, lessons: next });
  };
  const candidates = documents.filter(
    (d) =>
      d.kind === "courses" &&
      d.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="writing-paper writing-structure writing-practice-structure">
      <span className="writing-eyebrow">PRACTICE COURSE</span>
      <h2>Design the learning sequence</h2>
      <a
        href={"/learning/paths/" + value.path_id}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open published course ↗
      </a>
      <label>
        Title
        <input
          disabled={disabled}
          maxLength={300}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          disabled={disabled}
          maxLength={2000}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>Practice subject</legend>
        {(["algorithms", "sql"] as const).map((subject) => (
          <button
            key={subject}
            aria-pressed={value.subject === subject}
            onClick={() =>
              onChange({
                ...value,
                subject,
                track: subject === "sql" ? "backend" : "python",
              })
            }
          >
            {subject === "sql" ? "SQL" : "Python algorithms"}
          </button>
        ))}
      </fieldset>
      <details>
        <summary>Course introduction</summary>
        <label>
          Find a published course document
          <input
            aria-label="Find introduction document"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="writing-related-choices">
          <button
            disabled={disabled}
            aria-pressed={!value.overview}
            onClick={() => {
              const next = { ...value };
              delete next.overview;
              onChange(next);
            }}
          >
            No introduction
          </button>
          {candidates.map((d) => (
            <button
              key={d.note_id}
              disabled={disabled}
              aria-pressed={value.overview === d.note_id}
              onClick={() => onChange({ ...value, overview: d.note_id })}
            >
              {d.title}
            </button>
          ))}
        </div>
      </details>
      <h3>Lessons · {lessons.length}</h3>
      <p>
        Reordering keeps lesson identities, experiments, submissions and
        checkpoints attached to their original lessons.
      </p>
      {lessons.map((lesson, index) => (
        <section className="writing-practice-lesson" key={lesson.id}>
          <header>
            <strong>
              {index + 1}. {lesson.title}
            </strong>
            <button
              disabled={disabled || !index}
              aria-label={"Move up " + lesson.title}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={15} />
            </button>
            <button
              disabled={disabled || index === lessons.length - 1}
              aria-label={"Move down " + lesson.title}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={15} />
            </button>
          </header>
          <details>
            <summary>Edit lesson</summary>
            <label>
              Lesson title
              <input
                disabled={disabled}
                maxLength={300}
                value={lesson.title}
                onChange={(e) => update(lesson.id, { title: e.target.value })}
              />
            </label>
            <label>
              Learning objective
              <textarea
                disabled={disabled}
                maxLength={2000}
                value={lesson.objective}
                onChange={(e) =>
                  update(lesson.id, { objective: e.target.value })
                }
              />
            </label>
            <label>
              Section label
              <input
                disabled={disabled}
                maxLength={100}
                value={lesson.stage}
                onChange={(e) => update(lesson.id, { stage: e.target.value })}
              />
            </label>
            <label>
              Experiment steps · one per line, up to 12
              <textarea
                disabled={disabled}
                value={lesson.experiment_plan.join("\n")}
                onChange={(e) =>
                  update(lesson.id, {
                    experiment_plan: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Synthetic experiment setup
              <textarea
                disabled={disabled}
                maxLength={20000}
                value={lesson.experiment_setup}
                onChange={(e) =>
                  update(lesson.id, { experiment_setup: e.target.value })
                }
              />
            </label>
            <details>
              <summary>
                Reading ·{" "}
                {documents.find((d) => d.note_id === lesson.reading_note_id)
                  ?.title || "Choose published course content"}
              </summary>
              <label>
                Find a reading
                <input
                  aria-label={"Find reading for " + lesson.title}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="writing-related-choices">
                <button
                  disabled={disabled}
                  aria-pressed={!lesson.reading_note_id}
                  onClick={() => update(lesson.id, { reading_note_id: null })}
                >
                  No reading yet
                </button>
                {candidates.map((d) => (
                  <button
                    key={d.note_id}
                    disabled={disabled}
                    aria-pressed={lesson.reading_note_id === d.note_id}
                    onClick={() =>
                      update(lesson.id, { reading_note_id: d.note_id })
                    }
                  >
                    {d.title}
                  </button>
                ))}
              </div>
            </details>
            {!value.path_base?.lessons[lesson.id] && (
              <button
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...value,
                    lessons: lessons.filter((row) => row.id !== lesson.id),
                  })
                }
              >
                Remove new lesson
              </button>
            )}
          </details>
        </section>
      ))}
      <button
        disabled={disabled}
        onClick={() =>
          onChange({
            ...value,
            lessons: [
              ...lessons,
              {
                id: value.path_id + "-" + requestId().slice(0, 8).toLowerCase(),
                title: "New lesson",
                objective: "",
                stage: "",
                reading_note_id: null,
                experiment_plan: [],
                experiment_setup: "",
              },
            ],
          })
        }
      >
        Add lesson
      </button>
      <label className="writing-archive-choice">
        <input
          type="checkbox"
          disabled={disabled}
          checked={Boolean(value.archived)}
          onChange={(e) => onChange({ ...value, archived: e.target.checked })}
        />
        Archive course from Learning discovery
      </label>
    </div>
  );
}

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  FileText,
  Layers3,
  Plus,
  Search,
  Save,
  Upload,
  X,
} from "lucide-react";
import {
  contentRequest,
  installCatalog,
  readerHref,
  type Collection,
  type CollectionBody,
  type ContentCatalog,
  type ContentRole,
  type DocumentMeta,
  type DraftMeta,
} from "./contentRegistry";
import { notesRequest, downloadNote, type Note } from "./notesClient";
import { requestId } from "./requestId";
import PracticeStructureEditor from "./PracticeStructureEditor";
import WritingConnections from "./WritingConnections";
import TechnologyIcon from "./TechnologyIcon";
import "./writingWorkspace.css";
const Editor = lazy(() => import("./NotesEditor"));
type Draft = {
  id?: string;
  note_id: number | null;
  kind: ContentRole;
  collection_id: string | null;
  title: string;
  content: string;
  folder: string;
  base_note_version: string | null;
  version?: number;
  review_company?: string;
  review_provenance?: string;
};
const emptyCatalog: ContentCatalog = {
  collections: [],
  documents: [],
  drafts: [],
};
const roles: ContentRole[] = ["notes", "plans", "reviews", "knowledge", "courses"];
const roleTitle = {
  notes: "Notes",
  plans: "Learning plans",
  reviews: "Interview & exam reviews",
  knowledge: "Knowledge",
  courses: "Courses",
};
const provenanceTitles: Record<string, string> = {
  owner: "My recollection",
  external: "External feedback",
  mixed: "Mixed / reflection",
  unknown: "Source unspecified",
};
const stamp = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const normalize = (d: Draft): Draft => ({
  id: d.id,
  note_id: d.note_id,
  kind: d.kind,
  collection_id: d.collection_id,
  title: d.title,
  content: d.content,
  folder: d.folder,
  base_note_version: d.base_note_version,
  version: d.version,
  review_company: d.review_company,
  review_provenance: d.review_provenance,
});
const blank = (kind: ContentRole, collection: string | null): Draft => ({
  note_id: null,
  kind,
  collection_id: kind === "knowledge" || kind === "courses" ? collection : null,
  review_company: "",
  review_provenance: "unknown",
  title: "Untitled",
  content: "",
  folder: "",
  base_note_version: null,
});
export default function WritingWorkspace() {
  const initial = window.location.pathname.split("/")[2] as ContentRole;
  const [kind, setKind] = useState<ContentRole>(
      roles.includes(initial) ? initial : "notes",
    ),
    [catalog, setCatalog] = useState(emptyCatalog),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""),
    [all, setAll] = useState(!roles.includes(initial)),
    [company, setCompany] = useState<string | null>(null),
    [archive, setArchive] = useState(false),
    [trash, setTrash] = useState(false),
    [confirmTrash, setConfirmTrash] = useState(false),
    [collection, setCollection] = useState<string | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [structure, setStructure] = useState<{
      row: Collection;
      body: CollectionBody;
    } | null>(null),
    [saved, setSaved] = useState(""),
    [pending, setPending] = useState<(() => void) | null>(null),
    [recovery, setRecovery] = useState<Draft | null>(null),
    [libraryOpen, setLibraryOpen] = useState(() => {
      try {
        return (
          window.innerWidth > 900 &&
          window.localStorage.getItem("codeos.writing.library") !== "closed"
        );
      } catch {
        return window.innerWidth > 900;
      }
    }),
    [needsClassification, setNeedsClassification] = useState(false),
    [structureRecovery, setStructureRecovery] = useState<{
      row: Collection;
      body: CollectionBody;
    } | null>(null);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const attempt = useRef<Record<string, { signature: string; key: string }>>(
      {},
    ),
    loadId = useRef(0),
    initialized = useRef(false),
    url = useRef(window.location.href);
  const active = structure || draft,
    dirty = Boolean(active && stamp(active) !== saved);
  const storageKey = draft
    ? `codeos.writing.${draft.id || draft.note_id || "new-" + draft.kind}`
    : "";
  const collections = catalog.collections.filter((c) => c.kind === kind);
  const selectedCollection = catalog.collections.find(
    (c) => c.id === collection,
  );
  const docs = catalog.documents.filter(
    (d) =>
      Boolean(d.deleted_at) === trash &&
      (archive ? d.kind === "reference" : all || d.kind === kind) &&
      (!collection || d.collection_id === collection) &&
      (!company || d.review_company === company),
  );
  const drafts = (trash ? [] : catalog.drafts).filter(
    (d) =>
      (all || d.kind === kind) &&
      (!collection || d.collection_id === collection) &&
      (!company || d.review_company === company),
  );
  const reload = async (q = query, signal?: AbortSignal) => {
    const result = await contentRequest<ContentCatalog>(
      "/writing/catalog" + (q ? "?q=" + encodeURIComponent(q) : ""),
      { signal },
    );
    if (signal?.aborted) return result;
    setCatalog(result);
    if (!q) installCatalog(result);
    return result;
  };
  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    url.current = window.location.href;
  };
  const guard = (action: () => void) => {
    if (busy) return;
    if (dirty || recovery || structureRecovery) setPending(() => action);
    else action();
  };
  const install = (rawValue: Draft) => {
    const value = normalize(rawValue);
    setNeedsClassification(false);
    setStructureRecovery(null);
    setDraft(value);
    setStructure(null);
    setSaved(stamp(value));
    setError("");
    setMessage("");
    setRecovery(null);
    attempt.current = {};
    setLibraryOpen(false);
    try {
      const raw = sessionStorage.getItem(
        `codeos.writing.${value.id || value.note_id || "new-" + value.kind}`,
      );
      const old = value.note_id
        ? sessionStorage.getItem(`codeos.notes.draft.${value.note_id}`)
        : null;
      if (raw) {
        const restored = JSON.parse(raw);
        if (restored.draft && stamp(restored.draft) !== stamp(value)) {
          setRecovery(
            value.kind === "reviews" && restored.draft.note_id === value.note_id
              ? {
                  ...restored.draft,
                  kind: "reviews",
                  collection_id: null,
                  review_company:
                    restored.draft.review_company || value.review_company,
                  review_provenance:
                    restored.draft.review_provenance || value.review_provenance,
                }
              : restored.draft,
          );
          attempt.current = restored.attempt || {};
        }
      } else if (old) {
        const restored = JSON.parse(old);
        if (restored.draft && typeof restored.draft.content === "string")
          setRecovery({
            ...value,
            title: restored.draft.title,
            content: restored.draft.content,
            folder: restored.draft.folder,
            base_note_version: restored.expected_version,
          });
      }
    } catch {
      setMessage(
        "Local draft recovery is unavailable. Save or export before leaving.",
      );
    }
  };
  const openDraft = async (meta: DraftMeta) => {
    const sequence = ++loadId.current;
    setBusy(true);
    setError("");
    try {
      const value = await contentRequest<Draft>("/writing/drafts/" + meta.id);
      if (sequence !== loadId.current) return;
      install(value);
      setKind(value.kind);
      setCollection(value.collection_id);
      navigate(`/writing/${value.kind}/draft/${meta.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (sequence === loadId.current) setBusy(false);
    }
  };
  const openNote = async (meta: DocumentMeta, source = catalog) => {
    const savedDraft = source.drafts.find((d) => d.note_id === meta.note_id);
    if (savedDraft) {
      await openDraft(savedDraft);
      return;
    }
    const sequence = ++loadId.current;
    setBusy(true);
    setError("");
    try {
      const n = await notesRequest<Note>("/notes/" + meta.note_id);
      if (sequence !== loadId.current) return;
      const role = meta.kind === "reference" ? kind : meta.kind;
      install({
        note_id: n.id,
        kind: role,
        collection_id: meta.collection_id,
        title: n.title,
        content: n.content,
        folder: n.path.includes("/")
          ? n.path.slice(0, n.path.lastIndexOf("/"))
          : "",
        base_note_version: n.updated_at,
        review_company: meta.review_company || "",
        review_provenance: meta.review_provenance || "unknown",
      });
      setNeedsClassification(meta.kind === "reference");
      setKind(role);
      setCollection(meta.collection_id);
      navigate(`/writing/${role}/${n.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (sequence === loadId.current) setBusy(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void reload(query, controller.signal)
        .then((c) => {
          if (initialized.current || controller.signal.aborted) return;
          initialized.current = true;
          const parts = window.location.pathname.split("/");
          const id = Number(parts[3]);
          if (parts[3] === "draft") {
            const found = c.drafts.find((d) => d.id === parts[4]);
            if (found) void openDraft(found);
            else
              setError(
                "Draft not found. Use the library to open the current document.",
              );
          } else if (id) {
            const found = c.documents.find((d) => d.note_id === id);
            if (found) void openNote(found, c);
            else
              setError(
                "Document unavailable. Search the library or archived references.",
              );
          } else if (
            parts[3] === "new" ||
            new URLSearchParams(window.location.search).has("new")
          ) {
            install(blank(kind, null));
            navigate("/writing/" + kind + "/new");
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);
  useEffect(() => {
    if (!draft || !dirty || recovery) return;
    try {
      sessionStorage.setItem(
        storageKey,
        stamp({ draft, attempt: attempt.current }),
      );
    } catch {
      setMessage("Local recovery is unavailable. Save or export your work.");
    }
  }, [draft, dirty, recovery, storageKey]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty || busy || recovery || structureRecovery) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const pop = () => {
      const destination = window.location.href;
      if (dirty || busy || recovery || structureRecovery) {
        window.history.pushState({}, "", url.current);
        if (!busy) setPending(() => () => window.location.assign(destination));
      } else window.location.reload();
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("popstate", pop);
    };
  }, [dirty, busy, recovery, structureRecovery]);
  useEffect(() => {
    if (!libraryOpen) return;
    const compact = window.matchMedia?.("(max-width: 900px)").matches;
    if (compact)
      document
        .querySelector<HTMLInputElement>(".writing-search input")
        ?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLibraryOpen(false);
        libraryToggle.current?.focus();
      }
      if (event.key === "Tab" && compact) {
        const controls = [
          libraryToggle.current,
          ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
            ".writing-navigation button:not(:disabled),.writing-library button:not(:disabled),.writing-library input",
          ),
        ].filter(Boolean) as HTMLElement[];
        if (event.shiftKey && document.activeElement === controls[0]) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === controls.at(-1)
        ) {
          event.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [libraryOpen]);
  const keyFor = (operation: string, payload: unknown) => {
    const signature = stamp(payload);
    if (attempt.current[operation]?.signature !== signature)
      attempt.current[operation] = { signature, key: requestId() };
    if (draft)
      try {
        sessionStorage.setItem(
          storageKey,
          stamp({ draft, attempt: attempt.current }),
        );
      } catch {}
    if (structure)
      try {
        sessionStorage.setItem(
          "codeos.writing.structure." + structure.row.id,
          stamp({ ...structure, attempt: attempt.current }),
        );
      } catch {
        /* Keep the current retry identity in memory. */
      }
    return attempt.current[operation].key;
  };
  const saveDraft = async (): Promise<Draft | null> => {
    if (!draft || busy || recovery || needsClassification) return null;
    setBusy(true);
    setError("");
    try {
      const { id, version, ...body } = draft;
      const payload = {
        ...body,
        title: body.title.trim(),
        expected_version: version || null,
      };
      const result = await contentRequest<Draft>(
        "/writing/drafts" + (id ? "/" + id : ""),
        {
          method: id ? "PUT" : "POST",
          headers: { "Idempotency-Key": keyFor("save", payload) },
          body: stamp(payload),
        },
      );
      const read = await contentRequest<Draft>("/writing/drafts/" + result.id);
      if (
        read.title !== draft.title.trim() ||
        read.content !== draft.content ||
        read.version !== result.version ||
        read.kind !== draft.kind ||
        (draft.kind === "reviews" &&
          (read.review_company !== (draft.review_company || "").trim() ||
            read.review_provenance !== (draft.review_provenance || "unknown")))
      )
        throw Error(
          "Draft save could not be confirmed. Retain your text and retry.",
        );
      setDraft(normalize(read));
      setSaved(stamp(normalize(read)));
      sessionStorage.removeItem(storageKey);
      if (draft.note_id)
        sessionStorage.removeItem("codeos.notes.draft." + draft.note_id);
      navigate(
        `/writing/${read.kind}/draft/${read.id}` + window.location.search,
      );
      setMessage("Draft saved. Published content is unchanged.");
      await reload();
      return read;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const rebaseDraft = async () => {
    if (!draft?.note_id || busy) return;
    setBusy(true);
    setError("");
    try {
      const current = await notesRequest<Note>("/notes/" + draft.note_id);
      setDraft({ ...draft, base_note_version: current.updated_at });
      setMessage(
        "Published base refreshed. Your working text is retained, without merging. Review the published reading before saving and publishing.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const publishDraft = async () => {
    if (!draft || dirty || !draft.id || !draft.version || busy || recovery)
      return;
    setBusy(true);
    setError("");
    try {
      const payload = { expected_version: draft.version };
      const result = await contentRequest<Note>(
        "/writing/drafts/" + draft.id + "/publish",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": keyFor("publish", { id: draft.id, ...payload }),
          },
          body: stamp(payload),
        },
      );
      const read = await notesRequest<Note>("/notes/" + result.id);
      if (read.content !== draft.content || read.title !== draft.title)
        throw Error(
          "Publication could not be confirmed. Keep your draft and retry.",
        );
      sessionStorage.removeItem(storageKey);
      if (draft.kind === "reviews") {
        const projection =
          await contentRequest<ContentCatalog>("/content/catalog");
        const meta = projection.documents.find(
          (row) => row.note_id === read.id,
        );
        if (
          meta?.kind !== "reviews" ||
          meta.review_company !== draft.review_company ||
          meta.review_provenance !== draft.review_provenance
        )
          throw Error(
            "Review classification could not be confirmed. Retain your text and retry.",
          );
      }
      const c = await reload();
      install({
        note_id: read.id,
        kind: draft.kind,
        collection_id: draft.collection_id,
        title: read.title,
        content: read.content,
        folder: draft.folder,
        base_note_version: read.updated_at,
        review_company: draft.review_company,
        review_provenance: draft.review_provenance,
      });
      navigate(`/writing/${draft.kind}/${read.id}`);
      setMessage("Published. Learning now reads this version.");
      setCatalog(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const moveDocument = async () => {
    if (
      !draft?.note_id ||
      !draft.base_note_version ||
      draft.id ||
      dirty ||
      busy ||
      recovery ||
      needsClassification ||
      (draft.kind !== "notes" && draft.kind !== "plans")
    )
      return;
    const noteId = draft.note_id;
    const targetKind = draft.kind === "notes" ? "plans" : "notes";
    const payload = {
      kind: targetKind,
      expected_version: draft.base_note_version,
    };
    setBusy(true);
    setError("");
    try {
      const endpoint = `/writing/documents/${noteId}/kind`;
      const moved = await contentRequest<Note>(endpoint, {
        method: "PUT",
        headers: {
          "Idempotency-Key": keyFor("reclassify", { noteId, ...payload }),
        },
        body: stamp(payload),
      });
      const catalog = await reload();
      const document = catalog.documents.find((row) => row.note_id === noteId);
      if (document?.kind !== targetKind || document.updated_at !== moved.updated_at)
        throw Error("Could not confirm the new section. Reload and try again.");
      sessionStorage.removeItem(storageKey);
      install({ ...draft, kind: targetKind, base_note_version: moved.updated_at });
      setKind(targetKind);
      navigate(`/writing/${targetKind}/${noteId}`);
      setMessage(`Moved to ${roleTitle[targetKind]}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openStructure = (row: Collection) => {
    setDraft(null);
    setRecovery(null);
    setStructureRecovery(null);
    const value = { row, body: structuredClone(row.draft || row.published!) };
    setStructure(value);
    setSaved(stamp(value));
    setError("");
    setMessage("");
    setCollection(row.id);
    setLibraryOpen(false);
    try {
      const local = sessionStorage.getItem(
        "codeos.writing.structure." + row.id,
      );
      if (local) {
        const restored = JSON.parse(local);
        if (
          stamp({ row: restored.row, body: restored.body }) !== stamp(value)
        ) {
          setStructureRecovery({ row: restored.row, body: restored.body });
          attempt.current = restored.attempt || {};
        }
      }
    } catch {
      setMessage("Structure recovery is unavailable; save before closing.");
    }
  };
  const saveStructure = async (publish = false) => {
    if (!structure || busy || structureRecovery) return false;
    setBusy(true);
    setError("");
    try {
      let row = structure.row;
      if (!publish) {
        const payload = {
          kind: row.kind,
          slug: row.slug,
          body: structure.body,
          expected_version: row.version || null,
        };
        row = await contentRequest<Collection>(
          "/writing/collections/" + row.id,
          {
            method: "PUT",
            headers: { "Idempotency-Key": keyFor("collection-save", payload) },
            body: stamp(payload),
          },
        );
      } else {
        if (dirty || !row.draft)
          throw Error("Save the structure draft before publishing");
        const payload = { expected_version: row.version };
        row = await contentRequest<Collection>(
          "/writing/collections/" + row.id + "/publish",
          {
            method: "POST",
            headers: {
              "Idempotency-Key": keyFor("collection-publish", {
                id: row.id,
                ...payload,
              }),
            },
            body: stamp(payload),
          },
        );
      }
      const c = await reload();
      const read = c.collections.find((v) => v.id === row.id);
      if (
        !read ||
        read.version !== row.version ||
        stamp(read.draft || read.published) !==
          stamp(row.draft || row.published)
      )
        throw Error("Structure read-back failed. Retain this draft and retry.");
      sessionStorage.removeItem("codeos.writing.structure." + row.id);
      openStructure(read);
      setMessage(
        publish
          ? "Structure published."
          : "Structure draft saved. Readers see the published structure.",
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (structure) void saveStructure();
        else void saveDraft();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [draft, structure, dirty, busy, recovery]);
  useEffect(() => {
    if (!structure || !dirty || structureRecovery) return;
    try {
      sessionStorage.setItem(
        "codeos.writing.structure." + structure.row.id,
        stamp({ ...structure, attempt: attempt.current }),
      );
    } catch {
      setMessage(
        "Local structure recovery is unavailable. Save before leaving.",
      );
    }
  }, [structure, dirty, structureRecovery]);
  const chooseRole = (role: ContentRole) =>
    guard(() => {
      setCompany(null);
      setLibraryOpen(true);
      setKind(role);
      setCollection(null);
      setDraft(null);
      setStructure(null);
      setSaved("");
      setQuery("");
      setArchive(false);
      setTrash(false);
      setAll(false);
      navigate("/writing/" + role + "/");
    });
  const restoreDocument = async (meta: DocumentMeta) => {
    setBusy(true);
    setError("");
    try {
      const payload = { expected_version: meta.updated_at };
      await notesRequest<Note>("/notes/" + meta.note_id + "/restore", {
        method: "POST",
        headers: {
          "Idempotency-Key": keyFor("restore", {
            id: meta.note_id,
            ...payload,
          }),
        },
        body: stamp(payload),
      });
      const read = await notesRequest<Note>("/notes/" + meta.note_id);
      if (read.deleted_at)
        throw Error("Restore could not be confirmed. Retry.");
      await reload();
      setMessage("Document restored. Open it from its content category.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const trashDocument = async () => {
    if (!draft?.note_id || dirty || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = { expected_version: draft.base_note_version };
      await notesRequest<Note>("/notes/" + draft.note_id + "/trash", {
        method: "POST",
        headers: {
          "Idempotency-Key": keyFor("trash", { id: draft.note_id, ...payload }),
        },
        body: stamp(payload),
      });
      const read = await notesRequest<Note>("/notes/" + draft.note_id);
      if (!read.deleted_at) throw Error("Trash could not be confirmed. Retry.");
      setDraft(null);
      setSaved("");
      await reload();
      setMessage("Moved to Trash. The document remains recoverable.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const newDocument = () =>
    guard(() => {
      if (["knowledge", "courses"].includes(kind) && !selectedCollection) {
        setError("Choose a topic or course for the new document.");
        return;
      }
      install({
        ...blank(kind, collection),
        review_company: kind === "reviews" ? company || "" : "",
      });
      navigate("/writing/" + kind + "/new");
    });
  const newCollection = () =>
    guard(() => {
      if (kind !== "knowledge" && kind !== "courses") return;
      const slug = "untitled-" + requestId().slice(0, 8).toLowerCase();
      openStructure({
        id: kind + ":" + slug,
        kind,
        slug,
        version: 0,
        published: null,
        draft: {
          title: "Untitled " + (kind === "courses" ? "course" : "topic"),
          description: "",
          track: "backend",
          entries: [],
        },
      });
      setSaved("");
    });
  return (
    <main className="writing-workspace">
      <header className="writing-topbar">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="writing-brand"
        >
          CodeOS <span>Notes</span>
        </a>
        <button
          ref={libraryToggle}
          onClick={() =>
            setLibraryOpen((v) => {
              const next = !v;
              try {
                window.localStorage.setItem(
                  "codeos.writing.library",
                  next ? "open" : "closed",
                );
              } catch {}
              return next;
            })
          }
          aria-expanded={libraryOpen}
        >
          Content library
        </button>
        <span className="writing-document-state" role="status">
          {busy
            ? "Working…"
            : recovery
              ? "Draft to recover"
              : dirty
                ? "Unsaved changes"
                : draft?.id
                  ? "Saved draft"
                  : draft
                    ? "Published document"
                    : structure?.row.draft
                      ? "Structure draft"
                      : "Content studio"}
        </span>
        {draft && (
          <>
            <button
              disabled={
                busy || !dirty || Boolean(recovery) || needsClassification
              }
              onClick={() => void saveDraft()}
            >
              <Save size={15} />
              Save draft
            </button>
            <button
              className="writing-publish"
              disabled={busy || dirty || !draft.id || Boolean(recovery)}
              onClick={() => void publishDraft()}
            >
              <Upload size={15} />
              Publish
            </button>
          </>
        )}
        {structure && (
          <>
            <button
              disabled={busy || !dirty || Boolean(structureRecovery)}
              onClick={() => void saveStructure()}
            >
              Save structure draft
            </button>
            <button
              className="writing-publish"
              disabled={
                busy ||
                dirty ||
                !structure.row.draft ||
                Boolean(structureRecovery)
              }
              onClick={() => void saveStructure(true)}
            >
              Publish structure
            </button>
          </>
        )}
        <a href="/learning/" target="_blank" rel="noopener noreferrer">
          Learning ↗
        </a>
        <a href="/career/" target="_blank" rel="noopener noreferrer">
          Career ↗
        </a>
      </header>
      {libraryOpen && (
        <button
          className="writing-library-backdrop"
          aria-label="Close content library"
          onClick={() => {
            setLibraryOpen(false);
            libraryToggle.current?.focus();
          }}
        />
      )}
      <div
        className={
          "writing-layout" +
          (libraryOpen ? " writing-library-open" : " writing-library-collapsed")
        }
      >
        <aside className="writing-navigation">
          <span className="writing-eyebrow">CREATE & ORGANIZE</span>
          <h1>Notes</h1>
          <nav aria-label="Notes content roles">
            <button
              aria-pressed={all && !archive && !trash}
              disabled={busy}
              onClick={() =>
                guard(() => {
                  setAll(true);
                  setArchive(false);
                  setTrash(false);
                  setCompany(null);
                  setCollection(null);
                  setLibraryOpen(true);
                })
              }
            >
              <Layers3 size={17} />
              <span>All documents</span>
              <small>
                {catalog.documents.filter((d) => !d.deleted_at).length}
              </small>
            </button>
            {roles.map((role) => (
              <button
                key={role}
                className={
                  kind === role && !archive && !all && !trash ? "active" : ""
                }
                aria-pressed={kind === role && !archive && !all && !trash}
                disabled={busy}
                onClick={() => chooseRole(role)}
              >
                {role === "notes" || role === "plans" || role === "reviews" ? (
                  <FileText size={17} />
                ) : role === "knowledge" ? (
                  <BookOpen size={17} />
                ) : (
                  <Layers3 size={17} />
                )}
                <span>{roleTitle[role]}</span>
                <small>
                  {
                    catalog.documents.filter(
                      (d) => d.kind === role && !d.deleted_at,
                    ).length
                  }
                </small>
              </button>
            ))}
          </nav>
          <p className="writing-role-description">
            {kind === "notes"
              ? "Your own explanations, observations and open questions."
              : kind === "plans"
                ? "Learning goals, timelines and next steps."
                : kind === "reviews"
                  ? "Recalled questions, interview feedback and post-exam reviews. Filter by company; retain source context."
                  : kind === "knowledge"
                    ? "Concepts, mechanisms and connections."
                    : "Teaching sequence, guided practice and lesson content."}
          </p>
          <div className="writing-section-heading">
            <strong>
              {kind === "knowledge"
                ? "TECHNOLOGY TOPICS"
                : kind === "courses"
                  ? "COURSES"
                  : kind === "reviews"
                    ? "COMPANIES"
                    : kind === "plans"
                      ? "YOUR PLANS"
                      : "YOUR NOTES"}
            </strong>
            {["knowledge", "courses"].includes(kind) && (
              <button
                disabled={busy}
                onClick={newCollection}
                aria-label={"New " + (kind === "courses" ? "course" : "topic")}
              >
                <Plus size={15} />
              </button>
            )}
          </div>
          {kind === "courses" && (
            <button
              className="writing-collection"
              disabled={busy}
              onClick={() =>
                guard(() => {
                  const pathId =
                    "course-" + requestId().slice(0, 8).toLowerCase();
                  openStructure({
                    id: "courses:practice-" + pathId,
                    kind: "courses",
                    slug: "practice-" + pathId,
                    version: 0,
                    published: null,
                    draft: {
                      path_id: pathId,
                      subject: "algorithms",
                      title: "Untitled practice course",
                      description: "",
                      track: "python",
                      entries: [],
                      lessons: [],
                      path_base: null,
                    },
                  });
                  setSaved("");
                })
              }
            >
              + New practice course
            </button>
          )}
          <button
            className="writing-collection"
            aria-pressed={!collection}
            onClick={() =>
              guard(() => {
                setCollection(null);
                setCompany(null);
                setAll(false);
                setArchive(false);
                setTrash(false);
                setLibraryOpen(true);
              })
            }
          >
            All{" "}
            {kind === "reviews" ? "companies" : roleTitle[kind].toLowerCase()}
          </button>
          {kind === "reviews" &&
            [
              ...new Set(
                catalog.documents
                  .filter((d) => d.kind === "reviews")
                  .map((d) => d.review_company || "未注明公司"),
              ),
            ]
              .sort()
              .map((name) => (
                <button
                  className="writing-collection"
                  key={name}
                  aria-pressed={company === name}
                  onClick={() =>
                    guard(() => {
                      setCompany(name);
                      setCollection(null);
                      setAll(false);
                      setArchive(false);
                      setTrash(false);
                      setLibraryOpen(true);
                    })
                  }
                >
                  <span>{name}</span>
                  <small>
                    {
                      catalog.documents.filter(
                        (d) =>
                          d.kind === "reviews" &&
                          d.review_company === name &&
                          !d.deleted_at,
                      ).length
                    }
                  </small>
                </button>
              ))}
          {collections.map((c) => (
            <div key={c.id} className="writing-collection-row">
              <button
                className="writing-collection"
                aria-pressed={collection === c.id}
                onClick={() =>
                  guard(() => {
                    setCollection(c.id);
                    setAll(false);
                    setCompany(null);
                    setLibraryOpen(true);
                  })
                }
              >
                <TechnologyIcon
                  technology={
                    (c.draft || c.published)?.path_id
                      ? (c.draft || c.published)?.subject === "sql"
                        ? "sql"
                        : "python"
                      : c.slug
                  }
                />
                <span>{(c.draft || c.published)?.title}</span>
                {c.draft && <small>Draft</small>}
              </button>
              <button
                aria-label={"Edit structure " + (c.draft || c.published)?.title}
                onClick={() => guard(() => openStructure(c))}
              >
                ···
              </button>
            </div>
          ))}
          <button
            className="writing-archive"
            onClick={() =>
              guard(() => {
                setArchive(true);
                setCompany(null);
                setLibraryOpen(true);
                setTrash(false);
                setCollection(null);
                setAll(false);
              })
            }
          >
            Imported references
          </button>
          <button
            className="writing-archive"
            onClick={() =>
              guard(() => {
                setTrash(true);
                setCompany(null);
                setLibraryOpen(true);
                setArchive(false);
                setAll(true);
                setCollection(null);
              })
            }
          >
            Trash · restore documents
          </button>
          <small className="writing-storage-note">
            Organized by purpose and subject.
          </small>
        </aside>
        <section className="writing-library" aria-label="Document library">
          <div className="writing-library-title">
            <div>
              <span className="writing-eyebrow">CONTENT LIBRARY</span>
              <h2>
                {all && !trash && !archive
                  ? "All documents"
                  : trash
                    ? "Trash"
                    : archive
                      ? "Imported references"
                      : selectedCollection
                        ? (
                            selectedCollection.draft ||
                            selectedCollection.published
                          )?.title
                        : roleTitle[kind]}
              </h2>
            </div>
            <button
              disabled={busy || archive || trash}
              onClick={newDocument}
              aria-label="New document"
            >
              <Plus size={18} />
            </button>
          </div>
          <label className="writing-search">
            <Search size={16} />
            <input
              type="search"
              maxLength={300}
              aria-label="Search Notes"
              placeholder="Search title and text…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <label className="writing-global-search">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                setAll(e.target.checked);
                setCompany(null);
                setCollection(null);
              }}
            />
            Search all content
          </label>
          {loading && <p role="status">Loading library…</p>}
          <div className="writing-list" aria-busy={loading}>
            {drafts.length > 0 && <h3>Saved drafts</h3>}
            {drafts.map((d) => (
              <button
                key={d.id}
                className={draft?.id === d.id ? "selected" : ""}
                aria-current={draft?.id === d.id ? "page" : undefined}
                disabled={busy}
                onClick={() => guard(() => void openDraft(d))}
              >
                <strong>{d.title}</strong>
                <span>{roleTitle[d.kind]} · Draft</span>
              </button>
            ))}
            {docs.length > 0 && (
              <h3>{trash ? "Restorable documents" : "Published documents"}</h3>
            )}
            {docs.map((d) => (
              <button
                key={d.note_id}
                className={draft?.note_id === d.note_id ? "selected" : ""}
                aria-current={draft?.note_id === d.note_id ? "page" : undefined}
                disabled={busy}
                onClick={() =>
                  guard(() => {
                    if (trash) void restoreDocument(d);
                    else void openNote(d);
                  })
                }
              >
                <strong>
                  {catalog.collections
                    .find((c) => c.id === d.collection_id)
                    ?.published?.entries.find((e) => e.noteId === d.note_id)
                    ?.title ||
                    d.display_title ||
                    d.title}
                </strong>
                <span>
                  {d.kind === "reference"
                    ? "Imported reference"
                    : roleTitle[d.kind]}{" "}
                  ·{" "}
                  {catalog.collections.find((c) => c.id === d.collection_id)
                    ?.published?.title ||
                    d.review_company ||
                    "Unassigned"}{" "}
                  ·{" "}
                  {d.kind === "reviews"
                    ? (provenanceTitles[d.review_provenance || "unknown"] ||
                        "Source unspecified") + " · "
                    : ""}
                  {trash ? "Restore document" : "Published"}
                </span>
              </button>
            ))}
            {!loading && !docs.length && !drafts.length && (
              <p>
                No documents match. Clear the search or choose another subject.
              </p>
            )}
          </div>
          <button
            className="writing-library-refresh"
            disabled={busy}
            onClick={() => void reload().catch((e) => setError(e.message))}
          >
            Refresh library
          </button>
        </section>
        <section
          className="writing-editor-panel"
          aria-label="Authoring workspace"
        >
          {error && (
            <div className="writing-alert" role="alert">
              <strong>{error}</strong>
              <div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void reload().catch((e) => setError(e.message))
                  }
                >
                  Reload library
                </button>
                {draft && (
                  <button
                    onClick={() => downloadNote(draft.title, draft.content)}
                  >
                    Export my text
                  </button>
                )}
              </div>
            </div>
          )}
          {message && (
            <p className="writing-message" role="status">
              {message}
            </p>
          )}
          {error && draft?.note_id && (
            <button disabled={busy} onClick={() => void rebaseDraft()}>
              Use current published version as draft base
            </button>
          )}
          {recovery && (
            <div className="writing-alert">
              <strong>A local draft is available.</strong>
              <p>Restore it without replacing the current published version.</p>
              <button
                onClick={() => {
                  setDraft(recovery);
                  setRecovery(null);
                }}
              >
                Recover draft
              </button>
              <button
                onClick={() => {
                  sessionStorage.removeItem(storageKey);
                  if (draft?.note_id)
                    sessionStorage.removeItem(
                      "codeos.notes.draft." + draft.note_id,
                    );
                  setRecovery(null);
                }}
              >
                Keep saved version
              </button>
              <button
                onClick={() => downloadNote(recovery.title, recovery.content)}
              >
                Export recovery
              </button>
            </div>
          )}
          {structure && structure.row.published && (
            <button
              disabled={busy}
              onClick={() =>
                guard(() => {
                  sessionStorage.removeItem(
                    "codeos.writing.structure." + structure.row.id,
                  );
                  openStructure({ ...structure.row, draft: null });
                  setSaved("");
                })
              }
            >
              Start from published structure
            </button>
          )}
          {structureRecovery && (
            <div className="writing-alert">
              <strong>An unsaved structure can be recovered.</strong>
              <button
                onClick={() => {
                  setStructure(structureRecovery);
                  setStructureRecovery(null);
                }}
              >
                Recover structure
              </button>
              <button
                onClick={() => {
                  sessionStorage.removeItem(
                    "codeos.writing.structure." + structureRecovery.row.id,
                  );
                  setStructureRecovery(null);
                }}
              >
                Keep saved structure
              </button>
            </div>
          )}
          {draft ? (
            <div className="writing-paper">
              <div className="writing-manuscript-meta">
                <span>
                  {roleTitle[draft.kind]} ·{" "}
                  {draft.id
                    ? "Saved draft"
                    : draft.note_id
                      ? "Published base"
                      : "New document"}
                </span>
                {draft.note_id && (
                  <a
                    href={readerHref(draft.note_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open published reading ↗
                  </a>
                )}
              </div>
              {needsClassification && (
                <div className="writing-alert">
                  <strong>
                    Classify this imported reference before creating its draft.
                  </strong>
                  <div>
                    {roles.map((role) => (
                      <button
                        key={role}
                        onClick={() => {
                          setDraft({
                            ...draft,
                            kind: role,
                            collection_id: null,
                          });
                          setKind(role);
                          setNeedsClassification(false);
                        }}
                      >
                        {roleTitle[role]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.kind === "reviews" && (
                <div className="writing-review-details">
                  <label>
                    Company
                    <input
                      aria-label="Review company"
                      maxLength={120}
                      disabled={busy || Boolean(recovery)}
                      value={draft.review_company || ""}
                      onChange={(e) =>
                        setDraft({ ...draft, review_company: e.target.value })
                      }
                    />
                  </label>
                  <fieldset disabled={busy || Boolean(recovery)}>
                    <legend>Source / provenance</legend>
                    {Object.entries({
                      owner: "My recollection",
                      external: "External feedback",
                      mixed: "Mixed / reflection",
                      unknown: "Unspecified",
                    }).map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={
                          (draft.review_provenance || "unknown") === value
                        }
                        onClick={() =>
                          setDraft({ ...draft, review_provenance: value })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </fieldset>
                </div>
              )}
              <label className="writing-title-label">
                Document title
                <input
                  aria-label="Document title"
                  maxLength={300}
                  value={draft.title}
                  disabled={busy || Boolean(recovery)}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </label>
              {["knowledge", "courses"].includes(draft.kind) && (
                <details className="writing-destination">
                  <summary>
                    Destination ·{" "}
                    {catalog.collections.find(
                      (c) => c.id === draft.collection_id,
                    )?.published?.title || "Choose a topic or course"}
                  </summary>
                  <div>
                    {catalog.collections
                      .filter((c) => c.kind === draft.kind)
                      .map((c) => (
                        <button
                          key={c.id}
                          disabled={busy}
                          aria-pressed={draft.collection_id === c.id}
                          onClick={() =>
                            setDraft({ ...draft, collection_id: c.id })
                          }
                        >
                          {(c.draft || c.published)?.title}
                        </button>
                      ))}
                  </div>
                </details>
              )}
              <div className="writing-manuscript notes-document">
                <Suspense fallback={<p role="status">Loading editor…</p>}>
                  <Editor
                    onSave={() => void saveDraft()}
                    value={draft.content}
                    disabled={busy || Boolean(recovery)}
                    onChange={(content) => setDraft({ ...draft, content })}
                  />
                </Suspense>
              </div>
              {draft.note_id && (
                <>
                  {draft.kind !== "plans" && (
                    <WritingConnections
                      noteId={draft.note_id}
                      role={draft.kind}
                    />
                  )}
                  <details className="writing-document-actions">
                    <summary>Document actions</summary>
                    {!needsClassification && (draft.kind === "notes" || draft.kind === "plans") && (
                      <button
                        type="button"
                        disabled={busy || dirty || Boolean(draft.id) || Boolean(recovery)}
                        onClick={() => void moveDocument()}
                      >
                        {draft.kind === "notes" ? "Move to Learning plans" : "Move to Notes"}
                      </button>
                    )}
                    <button
                      onClick={() => downloadNote(draft.title, draft.content)}
                    >
                      Export Markdown
                    </button>
                    <button
                      disabled={busy || dirty || Boolean(draft.id)}
                      onClick={() => setConfirmTrash(true)}
                    >
                      Move to Trash
                    </button>
                    <p>
                      Trash retains the document. Restore it from the library.
                    </p>
                  </details>
                </>
              )}
            </div>
          ) : structure ? (
            <StructureEditor
              value={structure.body}
              disabled={busy}
              documents={catalog.documents.filter((d) => !d.deleted_at)}
              collections={catalog.collections}
              kind={kind}
              onChange={(body) => setStructure({ ...structure, body })}
            />
          ) : (
            <div className="writing-welcome">
              <span className="writing-eyebrow">A PLACE FOR YOUR OUTPUT</span>
              <h2>Create with focus.</h2>
              <p>
                Find a note, explain a concept or shape a course. Saved drafts
                stay separate from what learners read.
              </p>
              <div>
                {roles.map((role) => (
                  <button key={role} onClick={() => chooseRole(role)}>
                    <strong>{roleTitle[role]}</strong>
                    <span>
                      {role === "notes"
                        ? "Capture your own understanding"
                        : role === "plans"
                          ? "Set goals and plan your next steps"
                          : role === "reviews"
                            ? "Interview feedback and exam recollections"
                            : role === "knowledge"
                              ? "Build a coherent conceptual model"
                              : "Design practice and guided learning"}
                    </span>
                  </button>
                ))}
              </div>
              <p>
                Choose a document from the library, or select a topic/course and
                create a new one.
              </p>
            </div>
          )}
        </section>
      </div>
      {confirmTrash && (
        <div className="writing-dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Move document to Trash"
            className="writing-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmTrash(false);
              if (e.key === "Tab") {
                const buttons = [
                  ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                if (e.shiftKey && document.activeElement === buttons[0]) {
                  e.preventDefault();
                  buttons.at(-1)?.focus();
                } else if (
                  !e.shiftKey &&
                  document.activeElement === buttons.at(-1)
                ) {
                  e.preventDefault();
                  buttons[0]?.focus();
                }
              }
            }}
          >
            <h2>Move this document to Trash?</h2>
            <p>
              It will leave Learning. Its content and identity are retained so
              you can restore it from Notes.
            </p>
            <button
              disabled={busy}
              onClick={() => {
                setConfirmTrash(false);
                void trashDocument();
              }}
            >
              Move to Trash
            </button>
            <button autoFocus onClick={() => setConfirmTrash(false)}>
              Cancel
            </button>
          </section>
        </div>
      )}
      {pending && (
        <div className="writing-dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved writing"
            className="writing-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPending(null);
              }
              if (e.key === "Tab") {
                const buttons = [
                  ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                if (e.shiftKey && document.activeElement === buttons[0]) {
                  e.preventDefault();
                  buttons.at(-1)?.focus();
                } else if (
                  !e.shiftKey &&
                  document.activeElement === buttons.at(-1)
                ) {
                  e.preventDefault();
                  buttons[0]?.focus();
                }
              }
            }}
          >
            <h2>Keep your writing?</h2>
            <p>
              Save a draft before changing documents, discard your unsaved
              changes, or keep writing.
            </p>
            <button
              disabled={busy || Boolean(recovery) || Boolean(structureRecovery)}
              onClick={() => {
                void (structure ? saveStructure() : saveDraft()).then((ok) => {
                  if (ok) {
                    const action = pending;
                    setPending(null);
                    action();
                  }
                });
              }}
            >
              Save draft and continue
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (storageKey) sessionStorage.removeItem(storageKey);
                setRecovery(null);
                setStructureRecovery(null);
                if (structure)
                  sessionStorage.removeItem(
                    "codeos.writing.structure." + structure.row.id,
                  );
                const action = pending;
                setPending(null);
                action();
              }}
            >
              Discard changes
            </button>
            <button autoFocus onClick={() => setPending(null)}>
              Keep writing
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
function StructureEditor({
  value,
  disabled,
  documents,
  collections,
  kind,
  onChange,
}: {
  value: CollectionBody;
  disabled: boolean;
  documents: DocumentMeta[];
  collections: Collection[];
  kind: ContentRole;
  onChange: (value: CollectionBody) => void;
}) {
  const move = (index: number, step: number) => {
    const entries = [...value.entries];
    [entries[index], entries[index + step]] = [
      entries[index + step],
      entries[index],
    ];
    onChange({ ...value, entries });
  };
  if (value.path_id)
    return (
      <PracticeStructureEditor
        value={value}
        disabled={disabled}
        documents={documents}
        onChange={onChange}
      />
    );
  return (
    <div className="writing-paper writing-structure">
      <span className="writing-eyebrow">TOPIC / COURSE STRUCTURE</span>
      <h2>Shape the learning material</h2>
      <label>
        Title
        <input
          disabled={disabled}
          value={value.title}
          maxLength={300}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          disabled={disabled}
          value={value.description}
          maxLength={2000}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>Direction</legend>
        {(["python", "go", "backend", "ai"] as const).map((track) => (
          <button
            key={track}
            aria-pressed={value.track === track}
            onClick={() => onChange({ ...value, track })}
          >
            {track === "backend"
              ? "Backend development"
              : track === "ai"
                ? "AI application development"
                : track === "go"
                  ? "Go"
                  : "Python"}
          </button>
        ))}
      </fieldset>
      <label>
        Practice approach
        <input
          disabled={disabled}
          value={value.practice || ""}
          onChange={(e) => onChange({ ...value, practice: e.target.value })}
        />
      </label>
      {kind === "courses" && (
        <details>
          <summary>Course introduction</summary>
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
            {documents
              .filter((d) => d.kind === "courses")
              .map((d) => (
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
      )}
      <h3>Published document order</h3>
      <ol>
        {value.entries.map((entry, index) => (
          <li key={entry.noteId}>
            <span>{index + 1}</span>
            <input
              aria-label={`Entry ${index + 1} title`}
              disabled={disabled}
              value={entry.title}
              onChange={(e) =>
                onChange({
                  ...value,
                  entries: value.entries.map((v, i) =>
                    i === index ? { ...v, title: e.target.value } : v,
                  ),
                })
              }
            />
            <button
              disabled={disabled || index === 0}
              aria-label={"Move up " + entry.title}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={15} />
            </button>
            <button
              disabled={disabled || index === value.entries.length - 1}
              aria-label={"Move down " + entry.title}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={15} />
            </button>
            <button
              disabled={disabled}
              aria-label={"Remove reference " + entry.title}
              onClick={() =>
                onChange({
                  ...value,
                  entries: value.entries.filter(
                    (v) => v.noteId !== entry.noteId,
                  ),
                })
              }
            >
              <X size={15} />
            </button>
          </li>
        ))}
      </ol>
      <details>
        <summary>Add an existing published document</summary>
        <div className="writing-existing-entries">
          {documents
            .filter(
              (d) =>
                d.kind === kind &&
                !value.entries.some((e) => e.noteId === d.note_id),
            )
            .map((d) => (
              <button
                key={d.note_id}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...value,
                    entries: [
                      ...value.entries,
                      { noteId: d.note_id, title: d.title },
                    ],
                  })
                }
              >
                {d.title}
              </button>
            ))}
        </div>
      </details>
      {kind === "knowledge" && (
        <>
          <h3>Related courses</h3>
          <div className="writing-related-choices">
            {collections
              .filter(
                (c) =>
                  c.kind === "courses" && c.published && !c.published.path_id,
              )
              .map((c) => (
                <button
                  key={c.id}
                  disabled={disabled}
                  aria-pressed={Boolean(value.courses?.includes(c.slug))}
                  onClick={() =>
                    onChange({
                      ...value,
                      courses: value.courses?.includes(c.slug)
                        ? value.courses.filter((v) => v !== c.slug)
                        : [...(value.courses || []), c.slug],
                    })
                  }
                >
                  {c.published?.title}
                </button>
              ))}
          </div>
          <h3>Related personal Notes</h3>
          <div className="writing-related-choices">
            {documents
              .filter((d) => d.kind === "notes")
              .map((d) => (
                <button
                  key={d.note_id}
                  disabled={disabled}
                  aria-pressed={Boolean(value.notes?.includes(d.note_id))}
                  onClick={() =>
                    onChange({
                      ...value,
                      notes: value.notes?.includes(d.note_id)
                        ? value.notes.filter((v) => v !== d.note_id)
                        : [...(value.notes || []), d.note_id],
                    })
                  }
                >
                  {d.title}
                </button>
              ))}
          </div>
        </>
      )}
      <label className="writing-archive-choice">
        <input
          type="checkbox"
          disabled={disabled}
          checked={Boolean(value.archived)}
          onChange={(e) => onChange({ ...value, archived: e.target.checked })}
        />
        Archive this collection from Learning
      </label>
      <p>
        Removing a reference or archiving a collection retains its documents and
        stable links.
      </p>
    </div>
  );
}

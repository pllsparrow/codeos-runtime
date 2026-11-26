"""Learning-owned independent authoring and atomic publication."""
from __future__ import annotations
from typing import Any
from uuid import uuid4

from psycopg.types.json import Jsonb
from .notes import NotesService, NotesError, clean_title, folder_path, record


class WritingService(NotesService):
    def _require_ready(self) -> None:
        super()._require_ready()
        with self.database.connection() as connection:
            row = connection.execute("select to_regclass('learning.writing_drafts') as drafts").fetchone()
            if not row["drafts"]:
                raise NotesError(503, "Writing is awaiting its approved database migration")

    @staticmethod
    def _practice_body(connection: Any, identity: str) -> dict[str, Any] | None:
        path = connection.execute("select * from learning.learning_paths where id=%s", (identity,)).fetchone()
        if not path:
            return None
        lessons = connection.execute("select * from learning.path_lessons where path_id=%s order by position", (identity,)).fetchall()
        fields = ("id", "title", "objective", "stage", "reading_note_id", "experiment_plan", "experiment_setup")
        body = {"path_id": identity, "title": path["title"], "description": path["objective"],
                "track": "backend" if path["subject"] == "sql" else "python", "subject": path["subject"],
                "practice": "Jupy / SQL" if path["subject"] == "sql" else "Jupy / OJ", "entries": [],
                "path_base": {"revision": path["revision"], "lessons": {row["id"]: record(row)["updated_at"] for row in lessons}},
                "lessons": [{key: row[key] for key in fields} for row in lessons]}
        if path["overview_note_id"]:
            body["overview"] = path["overview_note_id"]
        return body

    def _publish_practice(self, connection: Any, row: dict[str, Any]) -> None:
        body = row["draft"]
        identity = body["path_id"]
        current = self._practice_body(connection, identity)
        if (current["path_base"] if current else None) != body.get("path_base"):
            raise NotesError(409, "Practice curriculum changed; retain this draft and reload its published structure")
        lessons = body.get("lessons", [])
        ids = [lesson["id"] for lesson in lessons]
        old_ids = set(current["path_base"]["lessons"]) if current else set()
        if len(ids) != len(set(ids)) or not old_ids.issubset(ids):
            raise NotesError(422, "Keep existing lesson identities and use unique new lesson IDs; learner history cannot be deleted")
        for lesson in lessons:
            other = connection.execute("select path_id from learning.path_lessons where id=%s", (lesson["id"],)).fetchone()
            if other and other["path_id"] != identity:
                raise NotesError(422, "A lesson identity already belongs to another course")
            note_id = lesson.get("reading_note_id")
            if note_id:
                note = connection.execute("select n.deleted_at,d.kind from learning.notes n left join learning.writing_documents d on d.note_id=n.id where n.id=%s", (note_id,)).fetchone()
                if not note or note["deleted_at"] or note["kind"] != "courses":
                    raise NotesError(422, "Choose a published course document for each lesson reading")
        if current:
            connection.execute("update learning.learning_paths set title=%s,objective=%s,subject=%s,overview_note_id=%s,revision=revision+1 where id=%s", (body["title"], body["description"], body["subject"], body.get("overview"), identity))
            # Temporarily move positions outside the final range to respect the unique constraint.
            for index, lesson_id in enumerate(old_ids):
                connection.execute("update learning.path_lessons set position=%s where id=%s", (-100000-index, lesson_id))
        else:
            connection.execute("insert into learning.learning_paths(id,title,objective,subject,overview_note_id) values (%s,%s,%s,%s,%s)", (identity, body["title"], body["description"], body["subject"], body.get("overview")))
        for index, lesson in enumerate(lessons):
            connection.execute("""insert into learning.path_lessons(id,path_id,title,objective,position,reading_note_id,stage,experiment_plan,experiment_setup)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(id) do update set title=excluded.title,objective=excluded.objective,
                position=excluded.position,reading_note_id=excluded.reading_note_id,stage=excluded.stage,experiment_plan=excluded.experiment_plan,
                experiment_setup=excluded.experiment_setup,updated_at=clock_timestamp()""", (lesson["id"], identity, clean_title(lesson["title"]), lesson["objective"], index, lesson.get("reading_note_id"), lesson["stage"], Jsonb(lesson["experiment_plan"]), lesson["experiment_setup"]))

    def catalog(self, *, authoring: bool = False, query: str = "") -> dict[str, Any]:
        self._require_ready()
        with self.database.connection() as connection:
            collections = connection.execute("select * from learning.writing_collections order by kind, slug").fetchall()
            for row in collections:
                if row["published"] and row["published"].get("path_id"):
                    live = self._practice_body(connection, row["published"]["path_id"])
                    if live:
                        row["published"] = {**live, "archived": row["published"].get("archived", False)}
            documents = connection.execute("select n.id as note_id,coalesce(d.kind,'reference') as kind,d.collection_id,r.company as review_company,r.provenance as review_provenance,n.title,case when r.note_id is not null and length(split_part(n.content,chr(10),1)) between 1 and 200 then regexp_replace(split_part(n.content,chr(10),1),'^#+[[:space:]]*','') else n.title end as display_title,n.updated_at,n.deleted_at from learning.notes n left join learning.writing_documents d on n.id=d.note_id left join learning.writing_reviews r on r.note_id=n.id order by n.updated_at desc").fetchall()
            drafts = connection.execute("select id,note_id,kind,collection_id,title,version,updated_at,base_note_version,review_company,review_provenance from learning.writing_drafts order by updated_at desc").fetchall() if authoring else []
        if query and authoring:
            with self.database.connection() as connection:
                matching = {r["id"] for r in connection.execute("select id from learning.notes where strpos(lower(title || ' ' || content), lower(%s))>0", (query,)).fetchall()}
                matching_drafts = {r["id"] for r in connection.execute("select id from learning.writing_drafts where strpos(lower(title || ' ' || content), lower(%s))>0", (query,)).fetchall()}
            documents = [r for r in documents if r["note_id"] in matching]
            drafts = [r for r in drafts if r["id"] in matching_drafts]
        if not authoring:
            collections = [{"id": r["id"], "kind": r["kind"], "slug": r["slug"], "published": r["published"], "version": r["version"]} for r in collections if r["published"] and not r["published"].get("archived")]
        return {"collections": [record(r) for r in collections], "documents": [record(r) for r in documents if not r["deleted_at"] or authoring], "drafts": [record(r) for r in drafts]}

    @staticmethod
    def _collection(connection: Any, identity: str | None, kind: str, *, published: bool = True) -> Any:
        if kind in {"notes", "plans", "reviews"}:
            if identity:
                raise NotesError(422, "Notes, learning plans and reviews do not use a publication collection")
            return None
        row = connection.execute("select * from learning.writing_collections where id=%s for update", (identity,)).fetchone()
        if not row or row["kind"] != kind:
            raise NotesError(422, "Choose a matching Knowledge topic or course")
        if published and (not row["published"] or row["published"].get("archived")):
            raise NotesError(409, "Publish the topic or course before publishing its documents")
        return row

    def draft(self, identity: str) -> dict[str, Any]:
        self._require_ready()
        with self.database.connection() as connection:
            row = connection.execute("select * from learning.writing_drafts where id=%s", (identity,)).fetchone()
        if not row:
            raise NotesError(404, "Draft not found; it may already have been published")
        return record(row)

    def save_draft(self, key: str, payload: dict[str, Any], identity: str | None = None) -> dict[str, Any]:
        payload = {**payload, "title": clean_title(payload["title"]), "folder": folder_path(payload.get("folder", "")), "review_company": payload.get("review_company", "").strip(), "review_provenance": payload.get("review_provenance", "unknown")}
        def action(connection: Any) -> dict[str, Any]:
            self._collection(connection, payload.get("collection_id"), payload["kind"], published=False)
            note_id, base = payload.get("note_id"), payload.get("base_note_version")
            if note_id:
                self._current(connection, note_id, base or "")
                role = connection.execute("select kind from learning.writing_documents where note_id=%s", (note_id,)).fetchone()
                if role and role["kind"] not in {payload["kind"], "reference"}:
                    raise NotesError(409, "Changing a document's primary role requires explicit reclassification")
            elif base:
                raise NotesError(422, "A new document cannot have a published base version")
            values = (note_id, payload["kind"], payload.get("collection_id"), payload["title"], payload["content"], payload["folder"], base, payload["review_company"], payload["review_provenance"])
            if identity:
                row = connection.execute("select * from learning.writing_drafts where id=%s for update", (identity,)).fetchone()
                if not row or row["version"] != payload.get("expected_version") or row["note_id"] != note_id:
                    raise NotesError(409, "The saved draft changed; retain your text and open the current draft")
                saved = connection.execute("""update learning.writing_drafts set note_id=%s,kind=%s,collection_id=%s,title=%s,content=%s,folder=%s,base_note_version=%s,review_company=%s,review_provenance=%s,version=version+1,updated_at=clock_timestamp() where id=%s returning *""", (*values, identity)).fetchone()
            else:
                if note_id and connection.execute("select id from learning.writing_drafts where note_id=%s", (note_id,)).fetchone():
                    raise NotesError(409, "This document already has a saved draft; open it instead")
                saved = connection.execute("""insert into learning.writing_drafts(id,note_id,kind,collection_id,title,content,folder,base_note_version,review_company,review_provenance) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning *""", (uuid4(), *values)).fetchone()
            result = record(saved)
            result["id"] = str(result["id"])
            return result
        return self._write(key, {"action": "writing-save", "id": identity, **payload}, action)

    def reclassify(self, key: str, note_id: int, kind: str, version: str) -> dict[str, Any]:
        def action(connection: Any) -> dict[str, Any]:
            current = self._current(connection, note_id, version)
            role = connection.execute(
                "select kind, collection_id from learning.writing_documents where note_id=%s", (note_id,),
            ).fetchone()
            if not role or role["kind"] not in {"notes", "plans"} or role["collection_id"]:
                raise NotesError(422, "Only personal notes and learning plans can move between these sections")
            if role["kind"] == kind:
                return record(current)
            if connection.execute("select id from learning.writing_drafts where note_id=%s", (note_id,)).fetchone():
                raise NotesError(409, "Publish the saved draft before moving this document")
            linked_topic = connection.execute(
                """select 1 from learning.writing_collections
                where kind='knowledge' and (
                    published->'notes' @> jsonb_build_array(%s::bigint)
                    or draft->'notes' @> jsonb_build_array(%s::bigint)
                ) limit 1""",
                (note_id, note_id),
            ).fetchone()
            if kind == "plans" and linked_topic:
                raise NotesError(409, "Remove the link from its Knowledge topic before moving this note")
            connection.execute("update learning.writing_documents set kind=%s where note_id=%s", (kind, note_id))
            saved = connection.execute(
                "update learning.notes set updated_at=clock_timestamp() where id=%s returning *", (note_id,),
            ).fetchone()
            return record(saved)
        return self._write(key, {"action": "writing-reclassify", "id": note_id, "kind": kind, "version": version}, action)

    def publish(self, key: str, identity: str, version: int) -> dict[str, Any]:
        def action(connection: Any) -> dict[str, Any]:
            draft = connection.execute("select * from learning.writing_drafts where id=%s for update", (identity,)).fetchone()
            if not draft or draft["version"] != version:
                raise NotesError(409, "Draft changed or was published; reload before publishing")
            if not draft["content"].strip():
                raise NotesError(422, "Write document content before publishing; empty drafts can still be saved")
            collection = self._collection(connection, draft["collection_id"], draft["kind"])
            if draft["note_id"]:
                current = self._current(connection, draft["note_id"], draft["base_note_version"].isoformat())
                saved = connection.execute("update learning.notes set title=%s,content=%s,updated_at=clock_timestamp() where id=%s returning *", (draft["title"], draft["content"], current["id"])).fetchone()
            else:
                self._ensure_folder(connection, draft["folder"])
                path = (draft["folder"] + "/" if draft["folder"] else "") + str(uuid4()) + ".md"
                saved = connection.execute("insert into learning.notes(path,title,content) values (%s,%s,%s) returning *", (path, draft["title"], draft["content"])).fetchone()
            note_id = saved["id"]
            if draft["kind"] == "reviews":
                company = draft["review_company"].strip()
                if not company:
                    raise NotesError(422, "Choose a company before publishing this review")
                connection.execute("insert into learning.writing_reviews(note_id,company,provenance) values (%s,%s,%s) on conflict(note_id) do update set company=excluded.company,provenance=excluded.provenance", (note_id, company, draft["review_provenance"]))
            previous = connection.execute("select collection_id from learning.writing_documents where note_id=%s", (note_id,)).fetchone()
            connection.execute("insert into learning.writing_documents(note_id,kind,collection_id) values (%s,%s,%s) on conflict(note_id) do update set kind=excluded.kind,collection_id=excluded.collection_id", (note_id, draft["kind"], draft["collection_id"]))
            # Membership changes publish atomically with the body; concurrent structure drafts stay intact.
            affected = {draft["collection_id"], previous["collection_id"] if previous else None} - {None}
            for cid in affected:
                row = collection if collection and cid == collection["id"] else connection.execute("select * from learning.writing_collections where id=%s for update", (cid,)).fetchone()
                if not row or not row["published"]:
                    continue
                body = dict(row["published"])
                entries = body.get("entries", [])
                if cid == draft["collection_id"]:
                    if body.get("path_id"):
                        continue
                    if not any(e["noteId"] == note_id for e in entries):
                        entries = [*entries, {"noteId": note_id, "title": draft["title"]}]
                else:
                    entries = [e for e in entries if e["noteId"] != note_id]
                if entries != body.get("entries", []):
                    body["entries"] = entries
                    connection.execute("update learning.writing_collections set published=%s,version=version+1,updated_at=clock_timestamp() where id=%s", (Jsonb(body), cid))
            connection.execute("delete from learning.writing_drafts where id=%s", (identity,))
            return record(saved)
        return self._write(key, {"action": "writing-publish", "id": identity, "version": version}, action)

    def save_collection(self, key: str, identity: str, kind: str, slug: str, body: dict[str, Any], version: int | None) -> dict[str, Any]:
        body = {**body, "title": clean_title(body["title"]), "entries": [{**entry, "title": clean_title(entry["title"])} for entry in body.get("entries", [])]}
        def action(connection: Any) -> dict[str, Any]:
            row = connection.execute("select * from learning.writing_collections where id=%s for update", (identity,)).fetchone()
            if body.get("path_id"):
                expected_id = "practice-" + body["path_id"]
                if kind != "courses" or slug != expected_id or identity != "courses:" + expected_id or not body.get("subject"):
                    raise NotesError(422, "Practice courses require a stable matching identity and subject")
                if row and (row["draft"] or row["published"]).get("path_id") != body["path_id"]:
                    raise NotesError(409, "A course's storage identity cannot be changed")
                if not row or row["draft"] is None:
                    current = self._practice_body(connection, body["path_id"])
                    if (current["path_base"] if current else None) != body.get("path_base"):
                        raise NotesError(409, "Practice course changed; reload its structure before saving")
            elif row and (row["draft"] or row["published"]).get("path_id"):
                raise NotesError(422, "Keep the practice course identity")
            if row:
                if row["version"] != version or row["kind"] != kind or row["slug"] != slug:
                    raise NotesError(409, "Collection changed; reload before saving its structure")
                saved = connection.execute("update learning.writing_collections set draft=%s,version=version+1,updated_at=clock_timestamp() where id=%s returning *", (Jsonb(body), identity)).fetchone()
            else:
                if version is not None:
                    raise NotesError(409, "Collection no longer exists")
                saved = connection.execute("insert into learning.writing_collections(id,kind,slug,draft) values (%s,%s,%s,%s) returning *", (identity, kind, slug, Jsonb(body))).fetchone()
            return record(saved)
        return self._write(key, {"action": "writing-collection-save", "id": identity, "kind": kind, "slug": slug, "body": body, "version": version}, action)

    def publish_collection(self, key: str, identity: str, version: int) -> dict[str, Any]:
        def action(connection: Any) -> dict[str, Any]:
            row = connection.execute("select * from learning.writing_collections where id=%s for update", (identity,)).fetchone()
            if not row or row["version"] != version or row["draft"] is None:
                raise NotesError(409, "Collection draft changed; reload before publishing")
            ids = [e["noteId"] for e in row["draft"].get("entries", [])]
            if len(ids) != len(set(ids)):
                raise NotesError(422, "A document can appear only once in a collection")
            for note_id in [*ids, *([row["draft"]["overview"]] if row["draft"].get("overview") else [])]:
                n = connection.execute("select n.deleted_at,d.kind from learning.notes n left join learning.writing_documents d on d.note_id=n.id where n.id=%s", (note_id,)).fetchone()
                if not n or n["deleted_at"] or n["kind"] != row["kind"]:
                    raise NotesError(422, "Every entry must be a published document with the matching role")
            for course_id in row["draft"].get("courses", []):
                if not connection.execute("select id from learning.writing_collections where kind='courses' and slug=%s and published is not null", (course_id,)).fetchone():
                    raise NotesError(422, "A linked course must be published")
            for note_id in row["draft"].get("notes", []):
                personal = connection.execute("select n.id from learning.notes n join learning.writing_documents d on d.note_id=n.id where n.id=%s and n.deleted_at is null and d.kind='notes'", (note_id,)).fetchone()
                if not personal:
                    raise NotesError(422, "Linked personal Notes must be published Notes")
            if row["draft"].get("path_id"):
                self._publish_practice(connection, row)
                published = self._practice_body(connection, row["draft"]["path_id"])
                published["archived"] = row["draft"].get("archived", False)
                connection.execute("update learning.writing_collections set draft=%s where id=%s", (Jsonb(published), identity))
            saved = connection.execute("update learning.writing_collections set published=draft,draft=null,version=version+1,updated_at=clock_timestamp() where id=%s returning *", (identity,)).fetchone()
            return record(saved)
        return self._write(key, {"action": "writing-collection-publish", "id": identity, "version": version}, action)

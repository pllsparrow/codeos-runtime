from __future__ import annotations

import re
from typing import Any


def canonical_skill(value: Any) -> tuple[str, str]:
    """Return a stable profile key without guessing a missing source topic."""
    display = str(value or "").strip() or "Unclassified"
    slug = re.sub(r"[^\w]+", "-", display.casefold(), flags=re.UNICODE).strip("-").replace("_", "-")
    slug = slug or "unclassified"
    return f"skill:{slug[:180]}", display[:200]


def latest_sources(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the last store-ordered revision for each source identity."""
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        selected[(str(row["service"]), str(row["source_id"]))] = row
    return list(selected.values())


def collect_skill_evidence(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Aggregate completed source facts while retaining concrete practice targets."""
    skills: dict[str, dict[str, Any]] = {}
    attempt_skills: dict[str, set[str]] = {}

    def skill_for(value: Any) -> dict[str, Any]:
        key, display = canonical_skill(value)
        return skills.setdefault(key, {
            "key": key,
            "display": display,
            "successful": 0,
            "observed": 0,
            "unresolved_problems": [],
            "unseen_problems": [],
            "prep_attempt_ids": set(),
            "review": None,
            "source_refs": [],
        })

    sources = latest_sources(rows)
    for source in sources:
        service = str(source["service"])
        source_id = str(source["source_id"])
        version = str(source.get("version") or "")
        content = source.get("content")
        source_ref = {"service": service, "source_id": source_id, "version": version}
        if service == "codelab" and source_id == "problems" and isinstance(content, list):
            for problem in content:
                if not isinstance(problem, dict):
                    continue
                skill = skill_for(problem.get("category"))
                if source_ref not in skill["source_refs"]:
                    skill["source_refs"].append(source_ref)
                target = {
                    "index": problem.get("index"),
                    "slug": str(problem.get("slug") or ""),
                    "title": str(problem.get("title") or problem.get("slug") or "OJ problem"),
                }
                status = problem.get("progress")
                if status == "accepted":
                    skill["successful"] += 1
                    skill["observed"] += 1
                elif status in {"attempted", "failed"}:
                    skill["observed"] += 1
                    skill["unresolved_problems"].append(target)
                elif status in {None, "todo", "not_started"}:
                    skill["unseen_problems"].append(target)
        elif service == "prep" and source_id.startswith("attempt/") and isinstance(content, dict):
            attempt_id = source_id.removeprefix("attempt/")
            for answer in content.get("answers", []):
                if not isinstance(answer, dict):
                    continue
                skill = skill_for(answer.get("topic"))
                attempt_skills.setdefault(attempt_id, set()).add(skill["key"])
                score = answer.get("score")
                if isinstance(score, bool) or not isinstance(score, (int, float)):
                    continue
                skill["successful"] += int(score > 0)
                skill["observed"] += 1
                if attempt_id.isdigit():
                    skill["prep_attempt_ids"].add(int(attempt_id))
                if source_ref not in skill["source_refs"]:
                    skill["source_refs"].append(source_ref)

    for source in sources:
        service = str(source["service"])
        source_id = str(source["source_id"])
        content = source.get("content")
        if service != "prep" or not source_id.startswith("reviews/") or not isinstance(content, list):
            continue
        reviews = [item for item in content if isinstance(item, dict)]
        if not reviews:
            continue
        attempt_id = source_id.removeprefix("reviews/")
        review = reviews[-1]
        tags = review.get("tags") if isinstance(review.get("tags"), list) else []
        tagged = [str(tag).strip() for tag in tags if str(tag).strip()]
        target_keys = {skill_for(tag)["key"] for tag in tagged} or attempt_skills.get(attempt_id, set())
        if not target_keys:
            continue
        detail = str(review.get("next_action") or review.get("notes") or review.get("verdict") or "Review recorded").strip()
        source_ref = {
            "service": service,
            "source_id": source_id,
            "version": str(source.get("version") or ""),
        }
        for key in target_keys:
            skill = skills[key]
            if attempt_id.isdigit():
                skill["prep_attempt_ids"].add(int(attempt_id))
            skill["review"] = {
                "attempt_id": int(attempt_id) if attempt_id.isdigit() else None,
                "verdict": str(review.get("verdict") or "").strip(),
                "detail": detail[:500],
            }
            if source_ref not in skill["source_refs"]:
                skill["source_refs"].append(source_ref)

    for skill in skills.values():
        skill["unresolved_problems"].sort(key=lambda item: (item["index"] is None, item["index"], item["slug"]))
        skill["unseen_problems"].sort(key=lambda item: (item["index"] is None, item["index"], item["slug"]))
        skill["prep_attempt_ids"] = sorted(skill["prep_attempt_ids"], reverse=True)
        skill["source_refs"].sort(key=lambda item: (item["service"], item["source_id"], item["version"]))
    return skills


def derived_skill_profiles(rows: list[dict[str, Any]], existing: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for skill in collect_skill_evidence(rows).values():
        observed = skill["observed"]
        review = skill["review"]
        if observed == 0 and review is None:
            continue
        successful = skill["successful"]
        if observed:
            ratio = successful / observed
            hypothesis = (
                f"{skill['display']}: {successful}/{observed} completed observations successful "
                f"({ratio:.0%})."
            )
        else:
            hypothesis = f"{skill['display']}: no scored observation is available."
        if skill["unresolved_problems"]:
            hypothesis += f" {len(skill['unresolved_problems'])} OJ problem(s) remain unresolved."
        if review is not None:
            label = review["verdict"].replace("_", " ") or "recorded"
            hypothesis += f" Owner review ({label}): {review['detail']}"
        confidence = min(0.9, 0.45 + 0.08 * observed + (0.08 if review is not None else 0))
        profiles.append({
            "topic": skill["key"],
            "hypothesis": hypothesis,
            "confidence": round(confidence, 3),
            "user_correction": existing.get(skill["key"], {}).get("user_correction"),
        })
    return sorted(profiles, key=lambda item: item["topic"])


def skill_plan_items(rows: list[dict[str, Any]], profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence = collect_skill_evidence(rows)
    items: list[dict[str, Any]] = []
    for profile in profiles:
        topic = str(profile["topic"])
        if not topic.startswith("skill:") or topic not in evidence:
            continue
        skill = evidence[topic]
        successful = int(skill["successful"])
        observed = int(skill["observed"])
        correction = str(profile.get("user_correction") or "").strip()
        review = skill["review"]
        review_verdict = review["verdict"] if review is not None else ""
        priority = "focus" if review_verdict in {"needs_review", "retry"} or observed == 0 or successful / observed < 0.7 else "reinforce"
        unresolved = skill["unresolved_problems"]
        unseen = skill["unseen_problems"]
        attempts = skill["prep_attempt_ids"]
        if unresolved and isinstance(unresolved[0]["index"], int):
            target = unresolved[0]
            title = f"Retry {target['title']}"
            action_label = "Continue OJ problem"
            href = f"/codelab/oj/problem/{target['index']}"
        elif unseen and isinstance(unseen[0]["index"], int):
            target = unseen[0]
            title = f"Practice {skill['display']}: {target['title']}"
            action_label = "Start OJ problem"
            href = f"/codelab/oj/problem/{target['index']}"
        elif attempts:
            title = f"Review {skill['display']} from Prep attempt #{attempts[0]}"
            action_label = "Open completed attempt"
            href = f"/learning/prep/?attempt={attempts[0]}"
        else:
            title = f"Review the {skill['display']} hypothesis"
            action_label = "Discuss with Mentor"
            href = "/learning/mentor/"
        items.append({
            "evidence_topic": topic,
            "title": title,
            "observation": correction or str(profile["hypothesis"]),
            "priority": priority,
            "action_label": action_label,
            "href": href,
            "confidence": float(profile["confidence"]),
            "corrected_by_user": bool(correction),
            "successful_count": successful,
            "observation_count": observed,
            "source_refs": skill["source_refs"],
        })
    order = {"focus": 0, "inspect": 1, "reinforce": 2}
    return sorted(items, key=lambda item: (order[item["priority"]], item["successful_count"] / max(1, item["observation_count"]), item["evidence_topic"]))

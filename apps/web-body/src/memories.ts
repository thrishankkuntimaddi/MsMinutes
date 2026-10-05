/** The memory viewer: what she remembers about you, and your control over it (ARCHITECTURE §11.2). */

type Memory = {
  id: string;
  kind: string;
  content: string;
  importance: number;
  updatedAt: string;
  recallCount: number;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 404 && path === "/api/memories")
    throw new Error("Her memory is off. Set MEMORY_DB in .env.");
  if (!res.ok && res.status !== 204)
    throw new Error(
      ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`,
    );
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export function setupMemories(): void {
  const dialog = $<HTMLDialogElement>("memories");
  const list = $("memory-list");
  const count = $("memory-count");
  const forgetAll = $<HTMLButtonElement>("forget-all");

  const render = (memories: Memory[]) => {
    list.replaceChildren();
    count.textContent = memories.length
      ? `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`
      : "";
    forgetAll.hidden = memories.length === 0;
    if (!memories.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Nothing yet. Tell her about yourself and she'll remember.";
      list.append(empty);
      return;
    }
    for (const m of memories) list.append(row(m));
  };

  const row = (m: Memory) => {
    const li = document.createElement("li");
    const kind = document.createElement("span");
    kind.className = `kind ${m.kind}`;
    kind.textContent = m.kind;
    const text = document.createElement("textarea");
    text.value = m.content;
    text.rows = 1;
    text.setAttribute("aria-label", "Memory");
    const save = async () => {
      const content = text.value.trim();
      if (!content || content === m.content) return;
      try {
        m.content = (
          await api<{ memory: Memory }>("PATCH", `/api/memories/${m.id}`, { content })
        ).memory.content;
        li.classList.add("saved");
        setTimeout(() => li.classList.remove("saved"), 900);
      } catch (e) {
        text.value = m.content;
        show(e);
      }
    };
    text.addEventListener("change", save);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        text.blur();
      }
    });
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${"●".repeat(Math.round(m.importance * 5)).padEnd(5, "○")}${m.recallCount ? ` · recalled ${m.recallCount}×` : ""}`;
    meta.title = `Importance ${m.importance.toFixed(1)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.textContent = "Forget";
    del.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/memories/${m.id}`);
        li.remove();
        void refresh();
      } catch (e) {
        show(e);
      }
    });
    li.append(kind, text, meta, del);
    return li;
  };

  const show = (e: unknown) => {
    list.replaceChildren();
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = e instanceof Error ? e.message : String(e);
    list.append(li);
  };

  const refresh = async () => {
    try {
      render((await api<{ memories: Memory[] }>("GET", "/api/memories")).memories);
    } catch (e) {
      show(e);
    }
  };

  $("open-memories").addEventListener("click", () => {
    dialog.showModal();
    forgetAll.textContent = "Forget everything";
    void refresh();
  });
  $("close-memories").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());

  $<HTMLFormElement>("memory-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("memory-text");
    const content = input.value.trim();
    if (!content) return;
    try {
      await api("POST", "/api/memories", {
        kind: $<HTMLSelectElement>("memory-kind").value,
        content,
        importance: 0.8,
      });
      input.value = "";
      void refresh();
    } catch (err) {
      show(err);
    }
  });

  // Two clicks, no browser dialog: the first arms it, the second forgets.
  forgetAll.addEventListener("click", async () => {
    if (forgetAll.dataset.armed !== "yes") {
      forgetAll.dataset.armed = "yes";
      forgetAll.textContent = "Really forget everything?";
      setTimeout(() => {
        forgetAll.dataset.armed = "";
        forgetAll.textContent = "Forget everything";
      }, 4000);
      return;
    }
    forgetAll.dataset.armed = "";
    try {
      await api("DELETE", "/api/memories?confirm=forget-everything");
      void refresh();
    } catch (err) {
      show(err);
    }
  });
}

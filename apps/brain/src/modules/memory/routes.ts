import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryService } from "./memory.js";
import { MEMORY_KINDS } from "./store.js";

const Id = z.object({ id: z.uuid() });
const NewMemory = z.object({
  kind: z.enum(MEMORY_KINDS).default("fact"),
  content: z.string().trim().min(1).max(500),
  importance: z.number().min(0).max(1).optional(),
});
const Patch = z
  .object({
    kind: z.enum(MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(500).optional(),
    importance: z.number().min(0).max(1).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "nothing to change");

/**
 * Her memories are yours to see and change (§11.2, a core trust feature).
 * Local admin API: the brain listens on localhost only by default.
 */
export function registerMemoryRoutes(app: FastifyInstance, memory: MemoryService): void {
  app.get("/api/memories", async () => ({ memories: await memory.list() }));

  app.post("/api/memories", async (req, reply) => {
    const body = NewMemory.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return reply.code(201).send({ memory: await memory.add(body.data) });
  });

  app.patch("/api/memories/:id", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = Patch.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "no such memory" });
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    const updated = await memory.edit(params.data.id, body.data);
    return updated ? { memory: updated } : reply.code(404).send({ error: "no such memory" });
  });

  app.delete("/api/memories/:id", async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success || !(await memory.forget(params.data.id))) {
      return reply.code(404).send({ error: "no such memory" });
    }
    return reply.code(204).send();
  });

  // Forgetting everything needs an explicit confirmation in the query string.
  app.delete("/api/memories", async (req, reply) => {
    if ((req.query as { confirm?: string }).confirm !== "forget-everything") {
      return reply.code(400).send({ error: "add ?confirm=forget-everything" });
    }
    return { forgotten: await memory.forgetAll() };
  });
}

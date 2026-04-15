import { MODELS_LIST } from "../../domain/models.ts";

export function handleModels(): Response {
  return Response.json({ object: "list", data: MODELS_LIST });
}

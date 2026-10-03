import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/auth";

const handler = toNextJsHandler((req: Request) => auth().handler(req));
export const { GET, POST } = handler;

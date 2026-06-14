import type { User } from "@alook/shared";
import { apiFetch } from "./client";

export const getMe = () => apiFetch<User>("/api/me");

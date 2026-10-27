export type Role = "admin" | "office_staff" | "judge";

export interface User {
  role: Role;
}

export const ALL_ROLES: Role[] = ["admin", "office_staff", "judge"];

import type { RouteRecordRaw } from "vue-router";
import AdminView from "./views/AdminView.vue";
import LoginView from "./views/LoginView.vue";
import MemberView from "./views/MemberView.vue";
import SetPasswordView from "./views/SetPasswordView.vue";

export const routes: RouteRecordRaw[] = [
  { path: "/login", component: LoginView },
  { path: "/set-password", component: SetPasswordView },
  { path: "/app", component: MemberView },
  { path: "/admin", component: AdminView },
  { path: "/:pathMatch(.*)*", redirect: "/login" },
];

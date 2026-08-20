import type { RouteRecordRaw } from "vue-router";
import AdminView from "./views/AdminView.vue";
import LoginView from "./views/LoginView.vue";
import MemberView from "./views/MemberView.vue";

export const routes: RouteRecordRaw[] = [
  { path: "/login", component: LoginView },
  { path: "/app", component: MemberView },
  { path: "/admin", component: AdminView },
  { path: "/:pathMatch(.*)*", redirect: "/login" },
];

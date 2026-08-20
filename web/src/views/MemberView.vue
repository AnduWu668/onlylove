<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const member = ref<{ email: string; role: string }>();

onMounted(async () => {
  const response = await fetch("/api/session");
  if (!response.ok) {
    await router.replace({ path: "/login", query: { redirect: "/app" } });
    return;
  }
  member.value = (await response.json()).member;
});

async function signOut() {
  await fetch("/api/session", { method: "DELETE" });
  await router.replace("/login");
}
</script>

<template>
  <main class="member-page">
    <header class="member-header">
      <div>
        <p class="eyebrow">ONLYLOVE</p>
        <p class="member-email">{{ member?.email }}</p>
      </div>
      <button class="quiet-action" type="button" @click="signOut">退出</button>
    </header>

    <section class="twin-card">
      <span class="twin-orbit" aria-hidden="true"></span>
      <p class="step-label">你的理解空间</p>
      <h1>我的恋爱分身</h1>
      <p>
        通过真实的经历与选择，让它逐渐理解你的价值判断、关系边界与表达方式。
      </p>
      <button type="button">开始了解自己</button>
    </section>

    <section class="progress-card" aria-label="画像进度">
      <div>
        <strong>画像进度</strong>
        <span>0 / 8</span>
      </div>
      <div class="progress-track"><span></span></div>
      <p>完成理解与校准后，才会开始获得候选推荐。</p>
    </section>

    <nav class="member-nav" aria-label="成员导航">
      <button type="button" aria-current="page"><i></i>我的分身</button>
      <button type="button"><i></i>候选推荐</button>
      <button type="button"><i></i>联系</button>
      <button type="button"><i></i>我的</button>
    </nav>
  </main>
</template>


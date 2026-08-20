<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

type Gender = "female" | "male" | "";
type RequirementMode = "preferred" | "required";

interface ProfileResponse {
  profile: {
    nickname: string;
    birthDate: string;
    gender: Gender;
    heightCm: number | null;
    city: string;
    occupation: string;
  };
  matchCriteria: {
    version: number;
    desiredGender: Gender;
    ageMinimum: number | null;
    ageMaximum: number | null;
    ageMode: RequirementMode | null;
    heightMinimumCm: number | null;
    heightMaximumCm: number | null;
    heightMode: RequirementMode | null;
    acceptableCities: string[];
    occupationRequirement: string | null;
    occupationMode: RequirementMode | null;
  } | null;
}

const router = useRouter();
const member = ref<{ email: string; role: string }>();
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const success = ref("");
const version = ref<number>();
const form = reactive({
  nickname: "",
  birthDate: "",
  gender: "" as Gender,
  heightCm: "" as number | "",
  city: "",
  occupation: "",
  desiredGender: "" as Gender,
  ageUnlimited: true,
  ageMinimum: "" as number | "",
  ageMaximum: "" as number | "",
  ageMode: "preferred" as RequirementMode,
  heightUnlimited: true,
  heightMinimumCm: "" as number | "",
  heightMaximumCm: "" as number | "",
  heightMode: "preferred" as RequirementMode,
  acceptableCities: "",
  occupationUnlimited: true,
  occupationRequirement: "",
  occupationMode: "preferred" as RequirementMode,
});

const adultBirthDateLimit = (() => {
  const date = new Date();
  const year = date.getFullYear() - 18;
  const lastDayOfMonth = new Date(year, date.getMonth() + 1, 0).getDate();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(Math.min(date.getDate(), lastDayOfMonth)).padStart(2, "0");
  return `${year}-${month}-${day}`;
})();

function loadForm(data: ProfileResponse) {
  if (data.profile) {
    Object.assign(form, {
      nickname: data.profile.nickname,
      birthDate: data.profile.birthDate,
      gender: data.profile.gender,
      heightCm: data.profile.heightCm ?? "",
      city: data.profile.city,
      occupation: data.profile.occupation,
    });
  }
  if (!data.matchCriteria) return;
  const criteria = data.matchCriteria;
  version.value = criteria.version;
  Object.assign(form, {
    desiredGender: criteria.desiredGender,
    ageUnlimited: criteria.ageMinimum === null,
    ageMinimum: criteria.ageMinimum ?? "",
    ageMaximum: criteria.ageMaximum ?? "",
    ageMode: criteria.ageMode ?? "preferred",
    heightUnlimited: criteria.heightMinimumCm === null,
    heightMinimumCm: criteria.heightMinimumCm ?? "",
    heightMaximumCm: criteria.heightMaximumCm ?? "",
    heightMode: criteria.heightMode ?? "preferred",
    acceptableCities: criteria.acceptableCities.join("、"),
    occupationUnlimited: criteria.occupationRequirement === null,
    occupationRequirement: criteria.occupationRequirement ?? "",
    occupationMode: criteria.occupationMode ?? "preferred",
  });
}

onMounted(async () => {
  try {
    const session = await fetch("/api/session");
    if (!session.ok) {
      await router.replace({ path: "/login", query: { redirect: "/app" } });
      return;
    }
    member.value = (await session.json()).member;
    const response = await fetch("/api/member/profile");
    if (!response.ok) throw new Error("暂时无法读取资料，请稍后重试。");
    loadForm((await response.json()) as ProfileResponse);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "暂时无法读取资料。";
  } finally {
    loading.value = false;
  }
});

async function signOut() {
  await fetch("/api/session", { method: "DELETE" });
  await router.replace("/login");
}

function numberOrNull(value: number | "") {
  return value === "" ? null : Number(value);
}

function cities() {
  return [
    ...new Set(
      form.acceptableCities
        .split(/[、,，\n]/)
        .map((city) => city.trim())
        .filter(Boolean),
    ),
  ];
}

function validate() {
  if (form.gender === form.desiredGender) {
    return "MVP 目前仅支持成年异性长期关系，请选择异性。";
  }
  if (
    !form.ageUnlimited &&
    (form.ageMinimum === "" ||
      form.ageMaximum === "" ||
      form.ageMinimum > form.ageMaximum)
  ) {
    return "请填写有效的年龄范围。";
  }
  if (
    !form.heightUnlimited &&
    (form.heightMinimumCm === "" ||
      form.heightMaximumCm === "" ||
      form.heightMinimumCm > form.heightMaximumCm)
  ) {
    return "请填写有效的身高范围。";
  }
  if (cities().length === 0) return "请至少填写一个可接受城市。";
  if (!form.occupationUnlimited && !form.occupationRequirement.trim()) {
    return "请填写职业要求，或选择不限。";
  }
}

async function save() {
  error.value = validate() ?? "";
  success.value = "";
  if (error.value) return;

  saving.value = true;
  const payload = {
    profile: {
      nickname: form.nickname,
      birthDate: form.birthDate,
      gender: form.gender,
      heightCm: Number(form.heightCm),
      city: form.city,
      occupation: form.occupation,
    },
    matchCriteria: {
      desiredGender: form.desiredGender,
      ageMinimum: form.ageUnlimited ? null : numberOrNull(form.ageMinimum),
      ageMaximum: form.ageUnlimited ? null : numberOrNull(form.ageMaximum),
      ageMode: form.ageUnlimited ? null : form.ageMode,
      heightMinimumCm: form.heightUnlimited
        ? null
        : numberOrNull(form.heightMinimumCm),
      heightMaximumCm: form.heightUnlimited
        ? null
        : numberOrNull(form.heightMaximumCm),
      heightMode: form.heightUnlimited ? null : form.heightMode,
      acceptableCities: cities(),
      occupationRequirement: form.occupationUnlimited
        ? null
        : form.occupationRequirement,
      occupationMode: form.occupationUnlimited ? null : form.occupationMode,
    },
  };

  try {
    const response = await fetch("/api/member/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as ProfileResponse;
    if (!response.ok) throw new Error("资料未保存，请检查填写内容。");
    if (!data.matchCriteria) throw new Error("资料已返回，但缺少条件版本。");
    version.value = data.matchCriteria.version;
    success.value = `已保存，择偶条件版本 v${version.value}`;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "资料未保存，请稍后重试。";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="member-page profile-page">
    <header class="member-header">
      <div>
        <p class="eyebrow">ONLYLOVE</p>
        <p class="member-email">{{ member?.email }}</p>
      </div>
      <button class="quiet-action" type="button" @click="signOut">退出</button>
    </header>

    <section class="profile-intro">
      <p class="step-label">成员资料</p>
      <h1>先把真实的你，说清楚</h1>
      <p>这是建立我的恋爱分身前的第一步，择偶条件会形成后续推荐的匹配边界。</p>
    </section>

    <p v-if="loading" class="loading-state">正在读取资料…</p>
    <form v-else class="profile-form" @submit.prevent="save">
      <fieldset class="form-section">
        <legend>基础档案</legend>
        <p class="section-note">只填写稳定、可比较的基础信息。</p>
        <div class="field-grid">
          <div class="field field-full">
            <label for="nickname">昵称</label>
            <input id="nickname" v-model.trim="form.nickname" maxlength="40" required />
          </div>
          <div class="field">
            <label for="profile-birth-date">出生日期</label>
            <input
              id="profile-birth-date"
              v-model="form.birthDate"
              type="date"
              autocomplete="bday"
              :max="adultBirthDateLimit"
              required
            />
          </div>
          <div class="field">
            <label for="gender">性别</label>
            <select id="gender" v-model="form.gender" required>
              <option disabled value="">请选择</option>
              <option value="female">女</option>
              <option value="male">男</option>
            </select>
          </div>
          <div class="field">
            <label for="height-cm">身高（厘米）</label>
            <input
              id="height-cm"
              v-model.number="form.heightCm"
              type="number"
              inputmode="numeric"
              min="1"
              required
            />
          </div>
          <div class="field">
            <label for="city">当前城市</label>
            <input id="city" v-model.trim="form.city" maxlength="60" required />
          </div>
          <div class="field field-full">
            <label for="occupation">职业</label>
            <input id="occupation" v-model.trim="form.occupation" maxlength="80" required />
          </div>
        </div>
      </fieldset>

      <fieldset class="form-section">
        <legend>结构化择偶条件</legend>
        <p class="section-note">“必须满足”会作为硬边界，“只是偏好”用于排序参考。</p>

        <div class="field">
          <label for="desired-gender">希望匹配的性别</label>
          <select id="desired-gender" v-model="form.desiredGender" required>
            <option disabled value="">请选择</option>
            <option value="female">女</option>
            <option value="male">男</option>
          </select>
          <span class="field-hint">MVP 仅支持成年异性长期关系。</span>
        </div>

        <div class="condition-card">
          <div class="condition-heading">
            <strong>年龄范围</strong>
            <label class="check-label" for="age-unlimited">
              <input id="age-unlimited" v-model="form.ageUnlimited" type="checkbox" />不限
            </label>
          </div>
          <div v-if="!form.ageUnlimited" class="range-grid">
            <div class="field">
              <label for="age-minimum">最小年龄</label>
              <input id="age-minimum" v-model.number="form.ageMinimum" type="number" min="18" required />
            </div>
            <div class="field">
              <label for="age-maximum">最大年龄</label>
              <input id="age-maximum" v-model.number="form.ageMaximum" type="number" min="18" required />
            </div>
            <div class="field field-full">
              <label for="age-mode">条件强度</label>
              <select id="age-mode" v-model="form.ageMode">
                <option value="required">必须满足</option>
                <option value="preferred">只是偏好</option>
              </select>
            </div>
          </div>
        </div>

        <div class="condition-card">
          <div class="condition-heading">
            <strong>身高范围</strong>
            <label class="check-label" for="height-unlimited">
              <input id="height-unlimited" v-model="form.heightUnlimited" type="checkbox" />不限
            </label>
          </div>
          <div v-if="!form.heightUnlimited" class="range-grid">
            <div class="field">
              <label for="height-minimum">最低（厘米）</label>
              <input id="height-minimum" v-model.number="form.heightMinimumCm" type="number" min="1" required />
            </div>
            <div class="field">
              <label for="height-maximum">最高（厘米）</label>
              <input id="height-maximum" v-model.number="form.heightMaximumCm" type="number" min="1" required />
            </div>
            <div class="field field-full">
              <label for="height-mode">条件强度</label>
              <select id="height-mode" v-model="form.heightMode">
                <option value="required">必须满足</option>
                <option value="preferred">只是偏好</option>
              </select>
            </div>
          </div>
        </div>

        <div class="field">
          <label for="acceptable-cities">可接受城市</label>
          <input
            id="acceptable-cities"
            v-model="form.acceptableCities"
            placeholder="例如：上海、杭州"
            required
          />
          <span class="field-hint">多个城市用顿号或逗号分隔；城市属于硬条件。</span>
        </div>

        <div class="condition-card">
          <div class="condition-heading">
            <strong>职业要求</strong>
            <label class="check-label" for="occupation-unlimited">
              <input id="occupation-unlimited" v-model="form.occupationUnlimited" type="checkbox" />不限
            </label>
          </div>
          <div v-if="!form.occupationUnlimited" class="field-stack">
            <div class="field">
              <label for="occupation-requirement">简短要求</label>
              <input id="occupation-requirement" v-model.trim="form.occupationRequirement" maxlength="100" required />
            </div>
            <div class="field">
              <label for="occupation-mode">条件强度</label>
              <select id="occupation-mode" v-model="form.occupationMode">
                <option value="required">必须满足</option>
                <option value="preferred">只是偏好</option>
              </select>
            </div>
          </div>
        </div>
      </fieldset>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="success" class="save-success" role="status">{{ success }}</p>
      <button class="save-profile" type="submit" :disabled="saving">
        {{ saving ? "保存中…" : version ? "保存新版本" : "保存资料" }}
      </button>
    </form>

    <nav class="member-nav" aria-label="成员导航">
      <button type="button"><i></i>我的分身</button>
      <button type="button"><i></i>候选推荐</button>
      <button type="button"><i></i>联系</button>
      <button type="button" aria-current="page"><i></i>我的</button>
    </nav>
  </main>
</template>

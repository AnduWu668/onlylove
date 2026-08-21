<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
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

interface PortraitInterviewState {
  fixedInterview: {
    answered: number;
    total: number;
    completed: boolean;
    question: {
      id: string;
      number: number;
      prompt: string;
      options: { id: string; text: string }[];
    } | null;
  };
  progress: { completed: number; total: number };
}

interface InterviewMessage {
  id: string;
  role: "member" | "agent";
  content: string;
}

interface TwinConversationState {
  profileVersion: { id: string; version: number };
  messages: InterviewMessage[];
  autoFollowup?: { jobId: string; eventsUrl: string };
}

type CalibrationRating = "like" | "partial" | "unlike";

interface PortraitLifecycleState {
  status:
    | "draft"
    | "generating"
    | "generation_failed"
    | "calibrating"
    | "needs_more_understanding"
    | "ready_to_publish"
    | "published";
  message?: string;
  submittedVersion: { id: string; version: number } | null;
  publishedVersion: { id: string; version: number } | null;
  calibration?: {
    answered: number;
    total: number;
    likeCount: number;
    criticalFabrication: boolean;
    canPublish: boolean;
    scenarios: {
      id: string;
      number: number;
      prompt: string;
      prediction: string | null;
      answer: {
        rating: CalibrationRating;
        correction: string;
        criticalFabrication: boolean;
      } | null;
    }[];
  };
}

const router = useRouter();
const member = ref<{ email: string; role: string }>();
const loading = ref(true);
const profileLoaded = ref(false);
const saving = ref(false);
const error = ref("");
const success = ref("");
const version = ref<number>();
const activeTab = ref<"twin" | "recommendations" | "connections" | "profile">(
  "profile",
);
const interviewLoaded = ref(false);
const interviewLoading = ref(false);
const interviewSending = ref(false);
const interviewError = ref("");
const interviewInput = ref("");
const twinRole = ref<"interviewer" | "twin">("interviewer");
const twinLoaded = ref(false);
const twinLoading = ref(false);
const twinSending = ref(false);
const twinError = ref("");
const twinInput = ref("");
const twinConversation = ref<TwinConversationState>();
const portraitInterview = ref<PortraitInterviewState>();
const portraitLifecycle = ref<PortraitLifecycleState>();
const portraitActionPending = ref(false);
const portraitActionError = ref("");
const calibrationRating = ref<CalibrationRating>();
const calibrationCorrection = ref("");
const calibrationCriticalFabrication = ref(false);
const fixedSelected = ref<string[]>([]);
const fixedNoneApplies = ref(false);
const fixedFreeText = ref("");
const fixedSaving = ref(false);
const progressFeedback = ref("");
const quotaRemaining = ref<number>();
const interviewMessages = ref<InterviewMessage[]>([]);
const twinMessages = ref<InterviewMessage[]>([]);
let interviewEvents: EventSource | undefined;
let twinEvents: EventSource | undefined;
let portraitPoll: number | undefined;
let interviewRetry:
  | { clientMessageId: string; content: string }
  | undefined;
let twinRetry: { clientMessageId: string; content: string } | undefined;
let portraitSubmitRequestId: string | undefined;
const activeCalibrationScenario = computed(() =>
  portraitLifecycle.value?.status === "calibrating"
    ? portraitLifecycle.value.calibration?.scenarios.find(
        (scenario) => scenario.prediction && !scenario.answer,
      )
    : undefined,
);
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

async function jsonOrUndefined<T>(response: Response) {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

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

async function loadProfile() {
  loading.value = true;
  profileLoaded.value = false;
  error.value = "";
  try {
    const session = await fetch("/api/session");
    if (!session.ok) {
      await router.replace({ path: "/login", query: { redirect: "/app" } });
      return;
    }
    const sessionData = await jsonOrUndefined<{
      member: { email: string; role: string };
      requiresPasswordSetup?: boolean;
    }>(session);
    if (!sessionData) throw new Error();
    if (sessionData.requiresPasswordSetup) {
      await router.replace({
        path: "/set-password",
        query: { redirect: "/app" },
      });
      return;
    }
    member.value = sessionData.member;
    const response = await fetch("/api/member/profile");
    const data = response.ok
      ? await jsonOrUndefined<ProfileResponse>(response)
      : undefined;
    if (!data) throw new Error();
    loadForm(data);
    profileLoaded.value = true;
  } catch {
    error.value = "暂时无法读取资料，请稍后重试。";
  } finally {
    loading.value = false;
  }
}

onMounted(loadProfile);
onUnmounted(() => {
  interviewEvents?.close();
  twinEvents?.close();
  if (portraitPoll !== undefined) window.clearTimeout(portraitPoll);
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
    if (!response.ok) {
      error.value = "资料未保存，请检查填写内容。";
      return;
    }
    const data = await jsonOrUndefined<ProfileResponse>(response);
    if (!data?.matchCriteria) {
      error.value = "资料未保存，请稍后重试。";
      return;
    }
    version.value = data.matchCriteria.version;
    success.value = `已保存，择偶条件版本 v${version.value}`;
  } catch {
    error.value = "资料未保存，请稍后重试。";
  } finally {
    saving.value = false;
  }
}

async function loadPortraitLifecycle() {
  try {
    const response = await fetch("/api/member/portrait");
    const data = response.ok
      ? await jsonOrUndefined<PortraitLifecycleState>(response)
      : undefined;
    if (
      data &&
      [
        "draft",
        "generating",
        "generation_failed",
        "calibrating",
        "needs_more_understanding",
        "ready_to_publish",
        "published",
      ].includes(data.status)
    ) {
      portraitLifecycle.value = data;
      if (portraitPoll !== undefined) window.clearTimeout(portraitPoll);
      if (data.status === "generating") {
        portraitPoll = window.setTimeout(
          () => void loadPortraitLifecycle(),
          1_000,
        );
      }
    }
  } catch {
    // The interview remains usable when lifecycle state cannot be refreshed.
  }
}

async function loadInterview() {
  if (interviewLoaded.value || interviewLoading.value) return;
  interviewLoading.value = true;
  interviewError.value = "";
  try {
    const response = await fetch("/api/member/interview");
    const data = response.ok
      ? await jsonOrUndefined<{
          messages: {
            id: string;
            role: "member" | "agent";
            content: string;
          }[];
          fixedInterview?: PortraitInterviewState["fixedInterview"];
          progress?: PortraitInterviewState["progress"];
          autoFollowup?: { jobId: string; eventsUrl: string };
        }>(response)
      : undefined;
    if (!data) throw new Error();
    interviewMessages.value = data.messages.filter(
      (message) => !message.content.startsWith("固定访谈 "),
    );
    portraitInterview.value = {
      fixedInterview: data.fixedInterview ?? {
        answered: 10,
        total: 10,
        completed: true,
        question: null,
      },
      progress: data.progress ?? { completed: 0, total: 8 },
    };
    if (data.autoFollowup) {
      const answer = reactive<InterviewMessage>({
        id: `pending-${data.autoFollowup.jobId}`,
        role: "agent",
        content: "",
      });
      interviewMessages.value.push(answer);
      interviewSending.value = true;
      listenForInterview(data.autoFollowup.eventsUrl, answer, false);
    }
    await loadPortraitLifecycle();
    interviewLoaded.value = true;
  } catch {
    interviewError.value = "暂时无法读取访谈记录，请稍后重试。";
  } finally {
    interviewLoading.value = false;
  }
}

async function loadTwin() {
  if (twinLoaded.value || twinLoading.value) return;
  twinLoading.value = true;
  twinError.value = "";
  try {
    const response = await fetch("/api/member/twin");
    const data = response.ok
      ? await jsonOrUndefined<TwinConversationState>(response)
      : undefined;
    if (!data) throw new Error();
    twinConversation.value = data;
    twinMessages.value = data.messages;
    if (data.autoFollowup) {
      const answer = reactive<InterviewMessage>({
        id: `pending-${data.autoFollowup.jobId}`,
        role: "agent",
        content: "",
      });
      twinMessages.value.push(answer);
      twinSending.value = true;
      listenForTwin(data.autoFollowup.eventsUrl, answer, false);
    }
    twinLoaded.value = true;
  } catch {
    twinError.value = "暂时无法读取恋爱分身对话，请稍后重试。";
  } finally {
    twinLoading.value = false;
  }
}

function toggleNone() {
  if (fixedNoneApplies.value) fixedSelected.value = [];
}

async function submitFixedAnswer() {
  const question = portraitInterview.value?.fixedInterview.question;
  if (!question || fixedSaving.value) return;
  fixedSaving.value = true;
  interviewError.value = "";
  try {
    const response = await fetch(
      "/api/member/portrait/interview/fixed-answers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          selectedOptionIds: fixedSelected.value,
          noneApplies: fixedNoneApplies.value,
          freeText: fixedFreeText.value,
        }),
      },
    );
    const data = response.ok
      ? await jsonOrUndefined<
          PortraitInterviewState & {
            autoFollowup?: { jobId: string; eventsUrl: string };
          }
        >(response)
      : undefined;
    if (!data) throw new Error();
    portraitInterview.value = data;
    fixedSelected.value = [];
    fixedNoneApplies.value = false;
    fixedFreeText.value = "";
    if (data.autoFollowup) {
      const answer = reactive<InterviewMessage>({
        id: `pending-${data.autoFollowup.jobId}`,
        role: "agent",
        content: "",
      });
      interviewMessages.value.push(answer);
      interviewSending.value = true;
      listenForInterview(data.autoFollowup.eventsUrl, answer, false);
    }
  } catch {
    interviewError.value = "这道回答暂时没有保存，请稍后重试。";
  } finally {
    fixedSaving.value = false;
  }
}

function showTab(
  tab: "twin" | "recommendations" | "connections" | "profile",
) {
  activeTab.value = tab;
  if (tab === "twin") void loadInterview();
}

function showTwinRole(role: "interviewer" | "twin") {
  twinRole.value = role;
  if (role === "twin") void loadTwin();
}

function streamError(code?: string) {
  if (code === "MODEL_NOT_CONFIGURED") {
    return "画像访谈模型尚未配置，请联系管理员。";
  }
  if (code === "INTERVIEW_IN_PROGRESS") return "上一条回答仍在生成中。";
  return "这次回答生成失败，消息额度已退回，请稍后重试。";
}

function listenForInterview(
  eventsUrl: string,
  answer: InterviewMessage,
  quotaReserved = true,
) {
  interviewEvents?.close();
  interviewEvents = new EventSource(eventsUrl);
  interviewEvents.addEventListener("delta", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      text: string;
    };
    answer.content += payload.text;
  });
  interviewEvents.addEventListener("progress", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      completed: number;
      total: number;
      feedback: string;
    };
    if (portraitInterview.value) {
      portraitInterview.value.progress = {
        completed: payload.completed,
        total: payload.total,
      };
    }
    progressFeedback.value = payload.feedback;
  });
  interviewEvents.addEventListener("done", () => {
    interviewEvents?.close();
    interviewEvents = undefined;
    interviewSending.value = false;
  });
  interviewEvents.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent) || !event.data) return;
    const code = (JSON.parse(event.data) as { code?: string }).code;
    interviewError.value = quotaReserved
      ? streamError(code)
      : code === "MODEL_NOT_CONFIGURED"
        ? streamError(code)
        : "第一次动态追问生成失败，请稍后发送一条消息继续。";
    interviewMessages.value = interviewMessages.value.filter(
      (message) => message.id !== answer.id,
    );
    interviewEvents?.close();
    interviewEvents = undefined;
    interviewSending.value = false;
  });
}

async function sendInterview() {
  const content = interviewInput.value.trim();
  if (!content || interviewSending.value) return;
  interviewSending.value = true;
  interviewError.value = "";
  interviewInput.value = "";
  const clientMessageId =
    interviewRetry?.content === content
      ? interviewRetry.clientMessageId
      : crypto.randomUUID();
  interviewRetry = undefined;
  interviewMessages.value.push({
    id: clientMessageId,
    role: "member",
    content,
  });
  const answer = reactive({
    id: `pending-${clientMessageId}`,
    role: "agent" as const,
    content: "",
  });
  interviewMessages.value.push(answer);
  const rollback = () => {
    interviewMessages.value = interviewMessages.value.filter(
      (message) => message.id !== clientMessageId && message.id !== answer.id,
    );
    if (!interviewInput.value) interviewInput.value = content;
  };

  try {
    const response = await fetch("/api/member/interview/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId, content }),
    });
    const data = await jsonOrUndefined<{
      eventsUrl?: string;
      quotaRemaining?: number;
      code?: string;
    }>(response);
    if (!response.ok || !data?.eventsUrl) {
      interviewError.value = streamError(data?.code);
      rollback();
      interviewSending.value = false;
      return;
    }
    quotaRemaining.value = data.quotaRemaining;
    listenForInterview(data.eventsUrl, answer);
  } catch {
    interviewError.value = "网络中断，消息已恢复，请再次发送。";
    interviewRetry = { clientMessageId, content };
    rollback();
    interviewSending.value = false;
  }
}

function listenForTwin(
  eventsUrl: string,
  answer: InterviewMessage,
  quotaReserved = true,
) {
  twinEvents?.close();
  twinEvents = new EventSource(eventsUrl);
  twinEvents.addEventListener("delta", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { text: string };
    answer.content += payload.text;
  });
  twinEvents.addEventListener("progress", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      completed: number;
      total: number;
      feedback: string;
    };
    if (portraitInterview.value) {
      portraitInterview.value.progress = {
        completed: payload.completed,
        total: payload.total,
      };
    }
    progressFeedback.value = payload.feedback;
  });
  twinEvents.addEventListener("done", () => {
    twinEvents?.close();
    twinEvents = undefined;
    twinSending.value = false;
  });
  twinEvents.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent) || !event.data) return;
    const code = (JSON.parse(event.data) as { code?: string }).code;
    twinError.value =
      code === "MODEL_NOT_CONFIGURED"
        ? "恋爱分身模型尚未配置，请联系管理员。"
        : quotaReserved
          ? "这次回答生成失败，消息额度已退回，请稍后重试。"
          : "上一次恋爱分身回答生成失败，请重新发送。";
    twinMessages.value = twinMessages.value.filter(
      (message) => message.id !== answer.id,
    );
    twinEvents?.close();
    twinEvents = undefined;
    twinSending.value = false;
  });
}

async function sendTwin() {
  const content = twinInput.value.trim();
  if (!content || twinSending.value) return;
  twinSending.value = true;
  twinError.value = "";
  twinInput.value = "";
  const clientMessageId =
    twinRetry?.content === content
      ? twinRetry.clientMessageId
      : crypto.randomUUID();
  twinRetry = undefined;
  twinMessages.value.push({ id: clientMessageId, role: "member", content });
  const answer = reactive<InterviewMessage>({
    id: `pending-${clientMessageId}`,
    role: "agent",
    content: "",
  });
  twinMessages.value.push(answer);
  const rollback = () => {
    twinMessages.value = twinMessages.value.filter(
      (message) => message.id !== clientMessageId && message.id !== answer.id,
    );
    if (!twinInput.value) twinInput.value = content;
  };

  try {
    const response = await fetch("/api/member/twin/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId, content }),
    });
    const data = await jsonOrUndefined<{
      eventsUrl?: string;
      quotaRemaining?: number;
      code?: string;
    }>(response);
    if (!response.ok || !data?.eventsUrl) {
      twinError.value =
        data?.code === "TWIN_IN_PROGRESS"
          ? "上一条恋爱分身回答仍在生成中。"
          : "这条消息暂时无法发送，请稍后重试。";
      rollback();
      twinSending.value = false;
      return;
    }
    quotaRemaining.value = data.quotaRemaining;
    listenForTwin(data.eventsUrl, answer);
  } catch {
    twinError.value = "网络中断，消息已恢复，请再次发送。";
    twinRetry = { clientMessageId, content };
    rollback();
    twinSending.value = false;
  }
}

async function submitPortraitVersion() {
  if (portraitActionPending.value) return;
  portraitActionPending.value = true;
  portraitActionError.value = "";
  portraitSubmitRequestId ??= crypto.randomUUID();
  try {
    const response = await fetch("/api/member/portrait/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: portraitSubmitRequestId }),
    });
    const data = await jsonOrUndefined<PortraitLifecycleState & { code?: string }>(
      response,
    );
    if (!response.ok || !data?.status) {
      portraitActionError.value =
        data?.code === "PORTRAIT_DRAFT_REQUIRED"
          ? "先继续聊一会儿，让画像访谈员形成可提交的理解。"
          : data?.code === "PORTRAIT_DRAFT_UPDATING"
            ? "画像访谈员正在吸收你的最新纠正，完成后再提交。"
            : data?.code === "PORTRAIT_DRAFT_UPDATE_FAILED"
              ? "最新纠正还没有成功吸收，请继续聊一句后再提交。"
              : "这次理解暂时无法提交，请稍后重试。";
      return;
    }
    portraitLifecycle.value = data;
    if (data.status === "generating") {
      portraitPoll = window.setTimeout(() => void loadPortraitLifecycle(), 1_000);
    }
    portraitSubmitRequestId = undefined;
    calibrationRating.value = undefined;
    calibrationCorrection.value = "";
    calibrationCriticalFabrication.value = false;
  } catch {
    portraitActionError.value = "网络中断，请再次提交；不会重复创建版本。";
  } finally {
    portraitActionPending.value = false;
  }
}

async function submitCalibrationAnswer() {
  const scenario = activeCalibrationScenario.value;
  const rating = calibrationRating.value;
  if (!scenario || !rating || portraitActionPending.value) return;
  portraitActionPending.value = true;
  portraitActionError.value = "";
  try {
    const response = await fetch(
      `/api/member/portrait/calibration/${scenario.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rating,
          correction: rating === "like" ? "" : calibrationCorrection.value.trim(),
          criticalFabrication:
            rating === "like" ? false : calibrationCriticalFabrication.value,
        }),
      },
    );
    const data = response.ok
      ? await jsonOrUndefined<
          PortraitLifecycleState & {
            correctionFollowup?: { jobId: string; eventsUrl: string };
          }
        >(response)
      : undefined;
    if (!data) {
      portraitActionError.value = "这次判断没有保存，请稍后重试。";
      return;
    }
    portraitLifecycle.value = data;
    if (data.correctionFollowup) {
      const answer = reactive<InterviewMessage>({
        id: `pending-${data.correctionFollowup.jobId}`,
        role: "agent",
        content: "",
      });
      interviewMessages.value.push(answer);
      interviewSending.value = true;
      listenForInterview(data.correctionFollowup.eventsUrl, answer, false);
    }
    calibrationRating.value = undefined;
    calibrationCorrection.value = "";
    calibrationCriticalFabrication.value = false;
  } catch {
    portraitActionError.value = "这次判断没有保存，请稍后重试。";
  } finally {
    portraitActionPending.value = false;
  }
}

async function publishPortrait() {
  const versionId = portraitLifecycle.value?.submittedVersion?.id;
  if (!versionId || portraitActionPending.value) return;
  portraitActionPending.value = true;
  portraitActionError.value = "";
  try {
    const response = await fetch("/api/member/portrait/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
    const data = response.ok
      ? await jsonOrUndefined<PortraitLifecycleState>(response)
      : undefined;
    if (!data) {
      portraitActionError.value = "暂时无法发布，请确认校准已经通过。";
      return;
    }
    portraitLifecycle.value = data;
  } catch {
    portraitActionError.value = "暂时无法发布，请稍后重试。";
  } finally {
    portraitActionPending.value = false;
  }
}

async function withdrawPortrait() {
  if (portraitActionPending.value) return;
  portraitActionPending.value = true;
  portraitActionError.value = "";
  try {
    const response = await fetch("/api/member/portrait/publish", {
      method: "DELETE",
    });
    const data = response.ok
      ? await jsonOrUndefined<PortraitLifecycleState>(response)
      : undefined;
    if (!data) {
      portraitActionError.value = "暂时无法撤回发布，请稍后重试。";
      return;
    }
    portraitLifecycle.value = data;
    twinRole.value = "interviewer";
  } catch {
    portraitActionError.value = "暂时无法撤回发布，请稍后重试。";
  } finally {
    portraitActionPending.value = false;
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

    <template v-if="activeTab === 'twin'">
      <section class="interview-intro">
        <div>
          <p class="step-label">我的分身</p>
          <h1>{{ twinRole === "interviewer" ? "私有画像访谈员" : "我的恋爱分身" }}</h1>
        </div>
        <div class="interview-status">
          <span class="ai-badge">AI</span>
          <span v-if="portraitInterview && twinRole === 'interviewer'" class="portrait-progress">
            {{ portraitInterview.progress.completed }}/{{ portraitInterview.progress.total }}
          </span>
        </div>
        <p v-if="twinRole === 'interviewer'">
          它只与你交流，通过追问逐步理解你；它不是公开恋爱分身，也不会替你作出承诺。
        </p>
        <p v-else>
          这是明确标注为 AI 的恋爱分身；它会像公开交流时一样表达，但不能替你承诺或确认关系。
        </p>
        <div
          v-if="portraitLifecycle?.publishedVersion && portraitInterview?.fixedInterview.completed"
          class="twin-role-switch"
          aria-label="我的分身角色"
        >
          <button
            type="button"
            data-twin-role="interviewer"
            :aria-pressed="twinRole === 'interviewer'"
            @click="showTwinRole('interviewer')"
          >
            画像访谈员
          </button>
          <button
            type="button"
            data-twin-role="twin"
            :aria-pressed="twinRole === 'twin'"
            @click="showTwinRole('twin')"
          >
            恋爱分身
          </button>
        </div>
      </section>

      <p v-if="interviewLoading || (twinRole === 'twin' && twinLoading)" class="loading-state">
        {{ twinRole === "interviewer" ? "正在读取访谈…" : "正在读取恋爱分身对话…" }}
      </p>
      <section
        v-else-if="
          twinRole === 'interviewer' &&
          portraitInterview &&
          !portraitInterview.fixedInterview.completed
        "
        class="fixed-interview-panel"
      >
        <div class="fixed-question-heading">
          <span>固定访谈</span>
          <strong>
            {{ portraitInterview.fixedInterview.answered + 1 }}/{{ portraitInterview.fixedInterview.total }}
          </strong>
        </div>
        <form v-if="portraitInterview.fixedInterview.question" @submit.prevent="submitFixedAnswer">
          <fieldset>
            <legend>{{ portraitInterview.fixedInterview.question.prompt }}</legend>
            <p>可以多选、组合，也可以补充自己的真实情况。</p>
            <label
              v-for="option in portraitInterview.fixedInterview.question.options"
              :key="option.id"
              class="fixed-option"
            >
              <input
                v-model="fixedSelected"
                type="checkbox"
                :value="option.id"
                :disabled="fixedNoneApplies"
              />
              <span>{{ option.text }}</span>
            </label>
            <label class="fixed-option none-option">
              <input v-model="fixedNoneApplies" type="checkbox" @change="toggleNone" />
              <span>都不符合</span>
            </label>
          </fieldset>
          <label class="fixed-supplement">
            <span>自由补充（可选）</span>
            <textarea
              v-model="fixedFreeText"
              maxlength="2000"
              rows="3"
              placeholder="也可以写下选项没有覆盖的情况…"
            ></textarea>
          </label>
          <p v-if="interviewError" class="form-error" role="alert">
            {{ interviewError }}
          </p>
          <button
            type="submit"
            :disabled="
              fixedSaving ||
              (!fixedSelected.length && !fixedNoneApplies && !fixedFreeText.trim())
            "
          >
            {{ fixedSaving ? "保存中…" : "保存并继续" }}
          </button>
        </form>
      </section>
      <section v-else-if="twinRole === 'twin'" class="interview-panel" aria-live="polite">
        <div class="twin-session-note">
          <div>
            <strong>恋爱分身 · AI</strong>
            <span v-if="twinConversation">固定使用 v{{ twinConversation.profileVersion.version }}</span>
          </div>
          <p>
            如果回答不像你，直接说“这不像我，我会……”并补充真实语境；纠正会进入画像草稿，不会直接修改已发布版本。
          </p>
        </div>
        <p v-if="progressFeedback" class="portrait-feedback" role="status">
          {{ progressFeedback }}
        </p>
        <div v-if="twinMessages.length" class="message-list">
          <article
            v-for="message in twinMessages"
            :key="message.id"
            class="chat-message"
            :data-role="message.role"
          >
            <span>{{ message.role === "member" ? "我" : "恋爱分身 · AI" }}</span>
            <p>{{ message.content || "正在思考…" }}</p>
          </article>
        </div>
        <div v-else class="interview-empty">
          <strong>像第一次认识自己那样聊聊</strong>
          <p>可以问一个未见场景，感受分身会怎样判断和表达。</p>
        </div>
        <p v-if="twinError" class="form-error" role="alert">{{ twinError }}</p>
        <p v-if="quotaRemaining !== undefined" class="quota-note">
          今日还可发送 {{ quotaRemaining }} 条
        </p>
        <form class="interview-composer twin-composer" @submit.prevent="sendTwin">
          <label class="sr-only" for="twin-message">恋爱分身消息</label>
          <textarea
            id="twin-message"
            v-model="twinInput"
            maxlength="4000"
            rows="3"
            placeholder="问一个场景，或直接指出哪里不像你…"
            :disabled="twinSending"
            required
          ></textarea>
          <button type="submit" :disabled="twinSending || !twinInput.trim()">
            {{ twinSending ? "回答生成中…" : "发送" }}
          </button>
        </form>
      </section>
      <section v-else class="interview-panel" aria-live="polite">
        <section v-if="portraitLifecycle" class="portrait-lifecycle">
          <div class="portrait-version-heading">
            <div>
              <span>恋爱分身版本</span>
              <strong v-if="portraitLifecycle.submittedVersion">
                v{{ portraitLifecycle.submittedVersion.version }}
              </strong>
            </div>
            <span v-if="portraitLifecycle.status === 'published'" class="published-badge">
              已发布
            </span>
          </div>

          <template v-if="portraitLifecycle.status === 'draft'">
            <h2>准备好时，由你形成正式版本</h2>
            <p>自动访谈只更新画像草稿，只有你主动提交才会创建不可变版本。</p>
            <button
              class="submit-portrait"
              type="button"
              :disabled="portraitActionPending || interviewSending"
              @click="submitPortraitVersion"
            >
              {{ portraitActionPending ? "提交中…" : "提交本次理解" }}
            </button>
          </template>

          <template v-else>
            <p
              v-if="
                portraitLifecycle.publishedVersion &&
                portraitLifecycle.publishedVersion.id !==
                  portraitLifecycle.submittedVersion?.id
              "
              class="published-note"
            >
              已发布的 v{{ portraitLifecycle.publishedVersion.version }} 继续服务，直到你发布新版本。
            </p>

            <form
              v-if="activeCalibrationScenario"
              class="calibration-form"
              @submit.prevent="submitCalibrationAnswer"
            >
              <div class="calibration-progress">
                <span>未见场景校准</span>
                <strong>
                  {{ activeCalibrationScenario.number }}/{{ portraitLifecycle.calibration?.total }}
                </strong>
              </div>
              <h2>{{ activeCalibrationScenario.prompt }}</h2>
              <div class="twin-prediction">
                <span>分身预测回答 · AI</span>
                <p>{{ activeCalibrationScenario.prediction }}</p>
              </div>
              <fieldset class="calibration-ratings">
                <legend>这个回答像你吗？</legend>
                <label>
                  <input v-model="calibrationRating" type="radio" value="like" />
                  <span>像我</span>
                </label>
                <label>
                  <input v-model="calibrationRating" type="radio" value="partial" />
                  <span>部分像我</span>
                </label>
                <label>
                  <input v-model="calibrationRating" type="radio" value="unlike" />
                  <span>不像我</span>
                </label>
              </fieldset>
              <label v-if="calibrationRating && calibrationRating !== 'like'" class="calibration-correction">
                <span>请聚焦纠正哪里不像你</span>
                <textarea
                  v-model="calibrationCorrection"
                  maxlength="2000"
                  rows="3"
                  placeholder="写下你真实会怎样想或怎样做…"
                  required
                ></textarea>
              </label>
              <label
                v-if="calibrationRating && calibrationRating !== 'like'"
                class="critical-fabrication"
              >
                <input
                  v-model="calibrationCriticalFabrication"
                  name="critical-fabrication"
                  type="checkbox"
                />
                <span>回答捏造了关键事实</span>
              </label>
              <button
                type="submit"
                :disabled="
                  portraitActionPending ||
                  !calibrationRating ||
                  (calibrationRating !== 'like' && !calibrationCorrection.trim())
                "
              >
                {{ portraitActionPending ? "保存中…" : "保存并继续" }}
              </button>
            </form>

            <template v-else-if="portraitLifecycle.status === 'generating'">
              <h2>正在生成 10 道未见场景回答</h2>
              <p>版本已经保存，可以先离开这里；单 Worker 会继续处理。</p>
            </template>

            <template v-else-if="portraitLifecycle.status === 'generation_failed'">
              <h2>{{ portraitLifecycle.message }}</h2>
              <p>任务已在三次失败后停止，输入没有被修改。</p>
            </template>

            <template v-else-if="portraitLifecycle.status === 'needs_more_understanding'">
              <h2>{{ portraitLifecycle.message }}</h2>
              <p>你的纠正已经进入画像草稿；继续聊一聊，再提交新的同维度场景校准。</p>
              <button
                class="submit-portrait"
                type="button"
                :disabled="portraitActionPending || interviewSending"
                @click="submitPortraitVersion"
              >
                提交新的理解版本
              </button>
            </template>

            <template v-else-if="portraitLifecycle.status === 'ready_to_publish'">
              <h2>校准已通过，等待你主动发布</h2>
              <p>
                {{ portraitLifecycle.calibration?.likeCount }}/10 道回答像你，且没有关键事实捏造。
              </p>
              <button
                class="publish-portrait"
                type="button"
                :disabled="portraitActionPending || interviewSending"
                @click="publishPortrait"
              >
                发布 v{{ portraitLifecycle.submittedVersion?.version }}
              </button>
            </template>

            <template v-else-if="portraitLifecycle.status === 'published'">
              <h2>v{{ portraitLifecycle.publishedVersion?.version }} 已发布</h2>
              <p>它现在可以参与新的候选推荐和分身会话。</p>
              <button
                class="submit-portrait quiet-action"
                type="button"
                :disabled="portraitActionPending"
                @click="submitPortraitVersion"
              >
                提交新的理解版本
              </button>
            </template>

            <button
              v-if="portraitLifecycle.publishedVersion"
              class="withdraw-portrait"
              type="button"
              :disabled="portraitActionPending"
              @click="withdrawPortrait"
            >
              撤回当前发布
            </button>
          </template>
          <p v-if="portraitActionError" class="form-error" role="alert">
            {{ portraitActionError }}
          </p>
        </section>
        <p v-if="progressFeedback" class="portrait-feedback" role="status">
          {{ progressFeedback }}
        </p>
        <div v-if="interviewMessages.length" class="message-list">
          <article
            v-for="message in interviewMessages"
            :key="message.id"
            class="chat-message"
            :data-role="message.role"
          >
            <span>{{ message.role === "member" ? "我" : "画像访谈员 · AI" }}</span>
            <p>{{ message.content || "正在思考…" }}</p>
          </article>
        </div>
        <div v-else class="interview-empty">
          <strong>从一件你愿意讲的小事开始</strong>
          <p>例如：在关系里遇到分歧时，你通常会先做什么？</p>
        </div>
        <p v-if="interviewError" class="form-error" role="alert">
          {{ interviewError }}
        </p>
        <p v-if="quotaRemaining !== undefined" class="quota-note">
          今日还可发送 {{ quotaRemaining }} 条
        </p>
        <form class="interview-composer" @submit.prevent="sendInterview">
          <label class="sr-only" for="interview-message">访谈消息</label>
          <textarea
            id="interview-message"
            v-model="interviewInput"
            maxlength="4000"
            rows="3"
            placeholder="写下你的真实想法…"
            :disabled="interviewSending"
            required
          ></textarea>
          <button type="submit" :disabled="interviewSending || !interviewInput.trim()">
            {{ interviewSending ? "回答生成中…" : "发送" }}
          </button>
        </form>
      </section>
    </template>

    <template v-else-if="activeTab === 'profile'">
    <section class="profile-intro">
      <p class="step-label">成员资料</p>
      <h1>先把真实的你，说清楚</h1>
      <p>这是建立我的恋爱分身前的第一步，择偶条件会形成后续推荐的匹配边界。</p>
    </section>

    <section class="account-security">
      <div>
        <strong>账户安全</strong>
        <p>通过邮箱验证码设置或重置登录密码。</p>
      </div>
      <RouterLink
        class="security-link"
        :to="{ path: '/login', query: { recovery: '1', redirect: '/app' } }"
      >
        设置或重置密码
      </RouterLink>
    </section>

    <p v-if="loading" class="loading-state">正在读取资料…</p>
    <section v-else-if="!profileLoaded" class="load-failure" role="alert">
      <p>{{ error }}</p>
      <button class="load-retry" type="button" @click="loadProfile">重试</button>
    </section>
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
    </template>

    <section v-else class="coming-soon">
      <p class="step-label">ONLYLOVE</p>
      <h1>{{ activeTab === "recommendations" ? "候选推荐" : "联系" }}</h1>
      <p>这部分会在后续 MVP 切片中开放。</p>
    </section>

    <nav class="member-nav" aria-label="成员导航">
      <button
        type="button"
        :aria-current="activeTab === 'twin' ? 'page' : undefined"
        @click="showTab('twin')"
      ><i></i>我的分身</button>
      <button
        type="button"
        :aria-current="activeTab === 'recommendations' ? 'page' : undefined"
        @click="showTab('recommendations')"
      ><i></i>候选推荐</button>
      <button
        type="button"
        :aria-current="activeTab === 'connections' ? 'page' : undefined"
        @click="showTab('connections')"
      ><i></i>联系</button>
      <button
        type="button"
        :aria-current="activeTab === 'profile' ? 'page' : undefined"
        @click="showTab('profile')"
      ><i></i>我的</button>
    </nav>
  </main>
</template>

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
type OwnAgentRole = "interviewer" | "twin";

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

interface RecommendationState {
  eligibility: { eligible: boolean; reasons: string[] };
  capacity: number;
  remainingCapacity: number;
  dailyFetchAvailable: boolean;
  generating?: boolean;
  generationFailed?: boolean;
  candidates: CandidateRecommendation[];
  followupQuestions: { id: string; question: string }[];
}

interface CandidateRecommendation {
  id: string;
  avatarText: string;
  nickname: string;
  age: number;
  heightCm: number;
  city: string;
  occupation: string;
  reason: string;
}

interface CandidateTwinConversationState {
  conversationId: string;
  anonymousCode: string;
  profileVersion: { id: string; version: number };
  candidate?: {
    nickname: string;
    heightCm: number | null;
    city: string;
    occupation: string;
  };
  messages: InterviewMessage[];
  canReply: boolean;
  autoFollowup?: { jobId: string; eventsUrl: string };
}

type ContactRequestStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";

interface ContactCandidate {
  avatarText: string;
  nickname: string;
  age: number | null;
  heightCm: number | null;
  city: string;
  occupation: string;
  reason?: string;
}

interface ContactRequestState {
  id: string;
  status: ContactRequestStatus;
  createdAt: string;
  expiresAt: string;
  resolutionMessage?: string;
  conversation?: { id: string; anonymousCode: string };
  candidate: ContactCandidate;
}

interface ConnectionsState {
  incoming: ContactRequestState[];
  outgoing: ContactRequestState[];
  currentConnection: {
    id: string;
    createdAt: string;
    candidate: Omit<ContactCandidate, "reason"> | null;
  } | null;
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
const recommendations = ref<RecommendationState>();
const recommendationsLoading = ref(false);
const recommendationsPending = ref(false);
const recommendationsError = ref("");
const candidateTwinCandidate = ref<CandidateRecommendation>();
const candidateTwinEndpoint = ref("");
const candidateTwinRecommendation = ref<CandidateRecommendation>();
const candidateTwinConsent = ref(false);
const candidateTwinConversation = ref<CandidateTwinConversationState>();
const candidateTwinOpening = ref(false);
const candidateTwinSending = ref(false);
const candidateTwinInput = ref("");
const candidateTwinError = ref("");
const candidateTwinQuotaRemaining = ref<number>();
const contactRequestPending = ref(false);
const contactRequestSent = ref(false);
const connections = ref<ConnectionsState>();
const connectionsLoading = ref(false);
const connectionsPending = ref(false);
const connectionsError = ref("");
const ownedCandidateConversations = ref<CandidateTwinConversationState[]>([]);
const ownedCandidateConversationsLoading = ref(false);
const ownedCandidateConversationsLoaded = ref(false);
let candidateTwinEvents: EventSource | undefined;
let candidateTwinRetry:
  | { conversationId: string; clientMessageId: string; content: string }
  | undefined;
let portraitPoll: number | undefined;
let recommendationPoll: number | undefined;
const ownAgentChats = {
  interviewer: {
    input: interviewInput,
    sending: interviewSending,
    error: interviewError,
    messages: interviewMessages,
    endpoint: "/api/member/interview/messages",
  },
  twin: {
    input: twinInput,
    sending: twinSending,
    error: twinError,
    messages: twinMessages,
    endpoint: "/api/member/twin/messages",
  },
};
const ownAgentEvents: Partial<Record<OwnAgentRole, EventSource>> = {};
const ownAgentRetries: Partial<
  Record<OwnAgentRole, { clientMessageId: string; content: string }>
> = {};
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
  Object.values(ownAgentEvents).forEach((events) => events.close());
  candidateTwinEvents?.close();
  if (portraitPoll !== undefined) window.clearTimeout(portraitPoll);
  if (recommendationPoll !== undefined) window.clearTimeout(recommendationPoll);
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
    if (recommendations.value) await loadRecommendations();
  } catch {
    error.value = "资料未保存，请稍后重试。";
  } finally {
    saving.value = false;
  }
}

async function loadRecommendations() {
  recommendationsLoading.value = true;
  recommendationsError.value = "";
  try {
    const response = await fetch("/api/member/recommendations");
    const data = response.ok
      ? await jsonOrUndefined<RecommendationState>(response)
      : undefined;
    if (!data) throw new Error();
    recommendations.value = data;
    if (recommendationPoll !== undefined) {
      window.clearTimeout(recommendationPoll);
    }
    if (data.generating) {
      recommendationPoll = window.setTimeout(
        () => void loadRecommendations(),
        1_000,
      );
    }
  } catch {
    recommendationsError.value = "暂时无法读取候选推荐，请稍后重试。";
  } finally {
    recommendationsLoading.value = false;
  }
}

async function fetchRecommendations() {
  recommendationsPending.value = true;
  recommendationsError.value = "";
  try {
    const response = await fetch("/api/member/recommendations", {
      method: "POST",
    });
    const data = response.ok
      ? await jsonOrUndefined<RecommendationState>(response)
      : undefined;
    if (!data) {
      recommendationsError.value =
        response.status === 409
          ? "今天已经主动获取过推荐，明天再来看看。"
          : "暂时无法生成推荐，请稍后重试。";
      return;
    }
    recommendations.value = data;
    if (data.generating) {
      recommendationPoll = window.setTimeout(
        () => void loadRecommendations(),
        1_000,
      );
    }
  } catch {
    recommendationsError.value = "暂时无法生成推荐，请稍后重试。";
  } finally {
    recommendationsPending.value = false;
  }
}

async function skipCandidate(id: string) {
  recommendationsPending.value = true;
  recommendationsError.value = "";
  try {
    const response = await fetch(`/api/member/recommendations/${id}/skip`, {
      method: "POST",
    });
    if (!response.ok) throw new Error();
    if (recommendations.value) {
      recommendations.value = {
        ...recommendations.value,
        remainingCapacity: recommendations.value.remainingCapacity + 1,
        candidates: recommendations.value.candidates.filter(
          (candidate) => candidate.id !== id,
        ),
      };
    }
  } catch {
    recommendationsError.value = "暂时无法跳过这位候选，请稍后重试。";
  } finally {
    recommendationsPending.value = false;
  }
}

function requestCandidateTwin(
  candidate: CandidateRecommendation,
  endpoint = `/api/member/recommendations/${candidate.id}/twin-conversation`,
  canRequestContact = true,
) {
  candidateTwinCandidate.value = candidate;
  candidateTwinEndpoint.value = endpoint;
  candidateTwinRecommendation.value = canRequestContact ? candidate : undefined;
  candidateTwinConsent.value = false;
  candidateTwinError.value = "";
  contactRequestSent.value = false;
}

function closeCandidateTwin() {
  candidateTwinEvents?.close();
  candidateTwinEvents = undefined;
  candidateTwinCandidate.value = undefined;
  candidateTwinEndpoint.value = "";
  candidateTwinRecommendation.value = undefined;
  candidateTwinConversation.value = undefined;
  candidateTwinConsent.value = false;
  candidateTwinInput.value = "";
  candidateTwinSending.value = false;
  candidateTwinError.value = "";
  candidateTwinQuotaRemaining.value = undefined;
  contactRequestPending.value = false;
  contactRequestSent.value = false;
}

async function openCandidateTwin() {
  const candidate = candidateTwinCandidate.value;
  if (!candidate || !candidateTwinConsent.value || candidateTwinOpening.value) {
    return;
  }
  candidateTwinOpening.value = true;
  candidateTwinError.value = "";
  try {
    const response = await fetch(candidateTwinEndpoint.value, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentToOwnerVisibility: true }),
    });
    const data = response.ok
      ? await jsonOrUndefined<CandidateTwinConversationState>(response)
      : undefined;
    if (!data?.canReply) throw new Error();
    candidateTwinConversation.value = data;
    candidateTwinCandidate.value = undefined;
    if (data.autoFollowup) {
      const answer = reactive<InterviewMessage>({
        id: `pending-${data.autoFollowup.jobId}`,
        role: "agent",
        content: "",
      });
      data.messages.push(answer);
      candidateTwinSending.value = true;
      listenForCandidateTwin(data.autoFollowup.eventsUrl, answer);
    }
  } catch {
    candidateTwinError.value = "暂时无法进入这位候选的恋爱分身，请稍后重试。";
  } finally {
    candidateTwinOpening.value = false;
  }
}

async function createContactRequest() {
  const recommendation = candidateTwinRecommendation.value;
  if (!recommendation || contactRequestPending.value) return;
  contactRequestPending.value = true;
  candidateTwinError.value = "";
  try {
    const response = await fetch(
      `/api/member/recommendations/${recommendation.id}/contact-request`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error();
    contactRequestSent.value = true;
    if (recommendations.value) {
      recommendations.value = {
        ...recommendations.value,
        remainingCapacity: recommendations.value.remainingCapacity + 1,
        candidates: recommendations.value.candidates.filter(
          ({ id }) => id !== recommendation.id,
        ),
      };
    }
  } catch {
    candidateTwinError.value = "联系请求暂时没有发送，请确认双方状态后重试。";
  } finally {
    contactRequestPending.value = false;
  }
}

async function loadConnections() {
  if (connectionsLoading.value) return;
  connectionsLoading.value = true;
  connectionsError.value = "";
  try {
    const response = await fetch("/api/member/contact-requests");
    const data = response.ok
      ? await jsonOrUndefined<ConnectionsState>(response)
      : undefined;
    if (!data) throw new Error();
    connections.value = data;
  } catch {
    connectionsError.value = "暂时无法读取联系状态，请稍后重试。";
  } finally {
    connectionsLoading.value = false;
  }
}

function openRequesterTwin(request: ContactRequestState) {
  requestCandidateTwin(
    {
      id: request.id,
      ...request.candidate,
      age: request.candidate.age ?? 0,
      heightCm: request.candidate.heightCm ?? 0,
      reason: request.candidate.reason ?? "",
    },
    `/api/member/contact-requests/${request.id}/twin-conversation`,
    false,
  );
}

async function resolveContactRequest(
  request: ContactRequestState,
  action: "accept" | "reject",
) {
  if (connectionsPending.value) return;
  connectionsPending.value = true;
  connectionsError.value = "";
  try {
    const response = await fetch(
      `/api/member/contact-requests/${request.id}/${action}`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error();
    await loadConnections();
  } catch {
    connectionsError.value =
      action === "accept"
        ? "该请求目前无法接受，可能已经过期或双方状态已变化。"
        : "该请求暂时无法拒绝，请稍后重试。";
  } finally {
    connectionsPending.value = false;
  }
}

function contactStatus(status: ContactRequestStatus) {
  return {
    pending: "待处理",
    accepted: "已接受",
    rejected: "已拒绝",
    expired: "已过期（不算拒绝）",
    cancelled: "系统已取消",
  }[status];
}

function listenForCandidateTwin(eventsUrl: string, answer: InterviewMessage) {
  candidateTwinEvents?.close();
  const events = new EventSource(eventsUrl);
  candidateTwinEvents = events;
  events.addEventListener("delta", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { text: string };
    answer.content += payload.text;
  });
  events.addEventListener("done", () => {
    events.close();
    candidateTwinEvents = undefined;
    candidateTwinSending.value = false;
  });
  events.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent) || !event.data) return;
    candidateTwinConversation.value!.messages =
      candidateTwinConversation.value!.messages.filter(
        (message) => message.id !== answer.id,
      );
    candidateTwinError.value = "这次回答生成失败，消息额度已退回，请稍后重试。";
    events.close();
    candidateTwinEvents = undefined;
    candidateTwinSending.value = false;
  });
}

function candidateTwinPostFailure(code?: string) {
  if (code === "CANDIDATE_TWIN_QUOTA_USED") {
    return {
      message: "今日候选分身消息额度已用完，明天再继续。",
      retryable: false,
    };
  }
  if (code === "CANDIDATE_TWIN_IN_PROGRESS") {
    return { message: "上一条候选分身回答仍在生成中。", retryable: false };
  }
  if (
    code === "CANDIDATE_TWIN_UNAVAILABLE" ||
    code === "CONVERSATION_NOT_FOUND"
  ) {
    return { message: "这位候选目前无法继续分身会话。", retryable: false };
  }
  return { message: "这条消息暂时无法发送，原文已恢复。", retryable: true };
}

async function sendCandidateTwinMessage() {
  const conversation = candidateTwinConversation.value;
  const content = candidateTwinInput.value.trim();
  if (!conversation || !content || candidateTwinSending.value) return;
  candidateTwinSending.value = true;
  candidateTwinError.value = "";
  candidateTwinInput.value = "";
  const retry = candidateTwinRetry;
  const clientMessageId =
    retry?.conversationId === conversation.conversationId &&
    retry.content === content
      ? retry.clientMessageId
      : crypto.randomUUID();
  candidateTwinRetry = undefined;
  const message: InterviewMessage = {
    id: clientMessageId,
    role: "member",
    content,
  };
  const answer = reactive<InterviewMessage>({
    id: `pending-${clientMessageId}`,
    role: "agent",
    content: "",
  });
  conversation.messages.push(message, answer);
  const rollback = () => {
    conversation.messages = conversation.messages.filter(
      (item) => item.id !== message.id && item.id !== answer.id,
    );
    candidateTwinInput.value = content;
    candidateTwinSending.value = false;
  };
  try {
    const response = await fetch(
      `/api/member/candidate-twin-conversations/${conversation.conversationId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId, content }),
      },
    );
    const data = await jsonOrUndefined<{
      eventsUrl?: string;
      quotaRemaining?: number;
      code?: string;
    }>(response);
    if (!response.ok || !data?.eventsUrl) {
      const failure = candidateTwinPostFailure(data?.code);
      candidateTwinError.value = failure.message;
      if (failure.retryable) {
        candidateTwinRetry = {
          conversationId: conversation.conversationId,
          clientMessageId,
          content,
        };
      }
      rollback();
      return;
    }
    candidateTwinQuotaRemaining.value = data.quotaRemaining;
    listenForCandidateTwin(data.eventsUrl, answer);
  } catch {
    candidateTwinRetry = {
      conversationId: conversation.conversationId,
      clientMessageId,
      content,
    };
    candidateTwinError.value = "这条消息暂时无法发送，原文已恢复。";
    rollback();
  }
}

async function loadOwnedCandidateConversations() {
  if (ownedCandidateConversationsLoading.value) return;
  ownedCandidateConversationsLoading.value = true;
  try {
    const response = await fetch("/api/member/candidate-twin-conversations");
    const data = response.ok
      ? await jsonOrUndefined<{
          conversations: CandidateTwinConversationState[];
        }>(response)
      : undefined;
    if (!data) throw new Error();
    ownedCandidateConversations.value = data.conversations;
    ownedCandidateConversationsLoaded.value = true;
  } catch {
    candidateTwinError.value = "暂时无法读取访客会话记录，请稍后重试。";
  } finally {
    ownedCandidateConversationsLoading.value = false;
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
      listenForOwnAgent("interviewer", data.autoFollowup.eventsUrl, answer, false);
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
      listenForOwnAgent("twin", data.autoFollowup.eventsUrl, answer, false);
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
      listenForOwnAgent("interviewer", data.autoFollowup.eventsUrl, answer, false);
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
  if (tab === "recommendations") void loadRecommendations();
  if (tab === "connections") void loadConnections();
}

function showTwinRole(role: "interviewer" | "twin") {
  twinRole.value = role;
  if (role === "twin") void loadTwin();
}

function ownAgentFailure(
  role: OwnAgentRole,
  code: string | undefined,
  quotaReserved: boolean,
) {
  if (code === "MODEL_NOT_CONFIGURED") {
    return role === "interviewer"
      ? "画像访谈模型尚未配置，请联系管理员。"
      : "恋爱分身模型尚未配置，请联系管理员。";
  }
  if (!quotaReserved) {
    return role === "interviewer"
      ? "第一次动态追问生成失败，请稍后发送一条消息继续。"
      : "上一次恋爱分身回答生成失败，请重新发送。";
  }
  return "这次回答生成失败，消息额度已退回，请稍后重试。";
}

function postFailure(role: OwnAgentRole, code?: string) {
  if (role === "interviewer") {
    if (code === "INTERVIEW_IN_PROGRESS") return "上一条回答仍在生成中。";
    return ownAgentFailure(role, code, true);
  }
  return code === "TWIN_IN_PROGRESS"
    ? "上一条恋爱分身回答仍在生成中。"
    : "这条消息暂时无法发送，请稍后重试。";
}

function listenForOwnAgent(
  role: OwnAgentRole,
  eventsUrl: string,
  answer: InterviewMessage,
  quotaReserved = true,
) {
  const chat = ownAgentChats[role];
  ownAgentEvents[role]?.close();
  const events = new EventSource(eventsUrl);
  ownAgentEvents[role] = events;
  events.addEventListener("delta", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { text: string };
    answer.content += payload.text;
  });
  events.addEventListener("progress", (event) => {
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
  events.addEventListener("done", () => {
    events.close();
    delete ownAgentEvents[role];
    chat.sending.value = false;
  });
  events.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent) || !event.data) return;
    const code = (JSON.parse(event.data) as { code?: string }).code;
    chat.error.value = ownAgentFailure(role, code, quotaReserved);
    chat.messages.value = chat.messages.value.filter(
      (message) => message.id !== answer.id,
    );
    events.close();
    delete ownAgentEvents[role];
    chat.sending.value = false;
  });
}

async function sendOwnAgent(role: OwnAgentRole) {
  const chat = ownAgentChats[role];
  const content = chat.input.value.trim();
  if (!content || chat.sending.value) return;
  chat.sending.value = true;
  chat.error.value = "";
  chat.input.value = "";
  const retry = ownAgentRetries[role];
  const clientMessageId =
    retry?.content === content ? retry.clientMessageId : crypto.randomUUID();
  delete ownAgentRetries[role];
  chat.messages.value.push({ id: clientMessageId, role: "member", content });
  const answer = reactive<InterviewMessage>({
    id: `pending-${clientMessageId}`,
    role: "agent",
    content: "",
  });
  chat.messages.value.push(answer);
  const rollback = () => {
    chat.messages.value = chat.messages.value.filter(
      (message) => message.id !== clientMessageId && message.id !== answer.id,
    );
    if (!chat.input.value) chat.input.value = content;
  };

  try {
    const response = await fetch(chat.endpoint, {
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
      chat.error.value = postFailure(role, data?.code);
      rollback();
      chat.sending.value = false;
      return;
    }
    quotaRemaining.value = data.quotaRemaining;
    listenForOwnAgent(role, data.eventsUrl, answer);
  } catch {
    chat.error.value = "网络中断，消息已恢复，请再次发送。";
    ownAgentRetries[role] = { clientMessageId, content };
    rollback();
    chat.sending.value = false;
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
      listenForOwnAgent(
        "interviewer",
        data.correctionFollowup.eventsUrl,
        answer,
        false,
      );
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

      <section class="owned-candidate-conversations">
        <div class="owned-conversations-heading">
          <div>
            <strong>访客会话记录</strong>
            <p>这里只显示随机会话编号和只读原文，不会显示访客身份。</p>
          </div>
          <button
            class="load-owned-candidate-conversations"
            type="button"
            :disabled="ownedCandidateConversationsLoading"
            @click="loadOwnedCandidateConversations"
          >
            {{ ownedCandidateConversationsLoading ? "读取中…" : "查看记录" }}
          </button>
        </div>
        <article
          v-for="conversation in ownedCandidateConversations"
          :key="conversation.conversationId"
          class="owned-conversation"
        >
          <strong>会话 {{ conversation.anonymousCode }}</strong>
          <div class="message-list">
            <div
              v-for="message in conversation.messages"
              :key="message.id"
              class="chat-message"
              :data-role="message.role"
            >
              <span>{{ message.role === "member" ? "匿名访客" : "我的恋爱分身 · AI" }}</span>
              <p>{{ message.content }}</p>
            </div>
          </div>
        </article>
        <p
          v-if="ownedCandidateConversationsLoaded && !ownedCandidateConversations.length"
          class="empty-state"
        >
          还没有访客会话记录。
        </p>
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
        <form
          class="interview-composer twin-composer"
          @submit.prevent="sendOwnAgent('twin')"
        >
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
              :disabled="portraitActionPending || interviewSending || twinSending"
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
                :disabled="portraitActionPending || interviewSending || twinSending"
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
                :disabled="portraitActionPending || interviewSending || twinSending"
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
        <form
          class="interview-composer"
          @submit.prevent="sendOwnAgent('interviewer')"
        >
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

    <template
      v-else-if="activeTab === 'recommendations' || activeTab === 'connections'"
    >
      <section v-if="activeTab === 'recommendations'" class="recommendations-intro">
        <p class="step-label">候选推荐</p>
        <h1>值得进一步了解的人</h1>
        <p>双方的明确条件会先由代码过滤，再经过配对评估；没有达到阈值时宁可留空。</p>
      </section>

      <section
        v-if="candidateTwinConversation"
        class="candidate-twin-panel interview-panel"
        aria-live="polite"
      >
        <div class="candidate-twin-heading">
          <div>
            <p class="step-label">匿名分身会话</p>
            <h2>{{ candidateTwinConversation.candidate?.nickname }}的恋爱分身 · AI</h2>
          </div>
          <button
            class="close-candidate-twin quiet-action"
            type="button"
            @click="closeCandidateTwin"
          >
            {{ activeTab === "recommendations" ? "返回候选" : "返回联系" }}
          </button>
        </div>
        <p class="candidate-twin-warning">
          完整原文会提供给分身主人；请不要输入不愿提供给对方的个人信息。会话固定使用
          v{{ candidateTwinConversation.profileVersion.version }}，分身不能替主人承诺、安排见面或确认关系。
        </p>
        <div v-if="candidateTwinConversation.messages.length" class="message-list">
          <article
            v-for="message in candidateTwinConversation.messages"
            :key="message.id"
            class="chat-message"
            :data-role="message.role"
          >
            <span>{{ message.role === "member" ? "我" : "恋爱分身 · AI" }}</span>
            <p>{{ message.content || "正在思考…" }}</p>
          </article>
        </div>
        <div v-else class="interview-empty">
          <strong>从一个真实场景开始</strong>
          <p>这里交流的是明确标注为 AI 的恋爱分身，不是候选人本人。</p>
        </div>
        <p v-if="candidateTwinError" class="form-error" role="alert">
          {{ candidateTwinError }}
        </p>
        <p v-if="candidateTwinQuotaRemaining !== undefined" class="quota-note">
          今日还可发送 {{ candidateTwinQuotaRemaining }} 条
        </p>
        <div
          v-if="
            candidateTwinRecommendation &&
            candidateTwinConversation.messages.some(({ role }) => role === 'member')
          "
          class="contact-request-cta"
        >
          <p v-if="contactRequestSent" role="status">联系请求已发送，等待对方处理。</p>
          <button
            v-else
            class="create-contact-request"
            type="button"
            :disabled="contactRequestPending || candidateTwinSending"
            @click="createContactRequest"
          >
            {{ contactRequestPending ? "发送中…" : "发起真人联系" }}
          </button>
        </div>
        <form
          class="interview-composer candidate-twin-composer"
          @submit.prevent="sendCandidateTwinMessage"
        >
          <label class="sr-only" for="candidate-twin-message">候选恋爱分身消息</label>
          <textarea
            id="candidate-twin-message"
            v-model="candidateTwinInput"
            maxlength="4000"
            rows="3"
            placeholder="写下你想了解的场景…"
            :disabled="candidateTwinSending"
            required
          ></textarea>
          <button
            type="submit"
            :disabled="candidateTwinSending || !candidateTwinInput.trim()"
          >
            {{ candidateTwinSending ? "回答生成中…" : "发送" }}
          </button>
        </form>
      </section>

      <section v-else-if="candidateTwinCandidate" class="candidate-twin-consent">
        <p class="step-label">进入前确认</p>
        <h2>与{{ candidateTwinCandidate.nickname }}的恋爱分身交流</h2>
        <p v-if="candidateTwinRecommendation">
          这是 AI 分身，不是本人。你的完整原文会提供给{{ candidateTwinCandidate.nickname }}只读查看，
          匿名阶段不会向对方显示你的账号或候选卡；开始会话也不会通知对方。
        </p>
        <p v-else>
          这是 AI 分身，不是本人。你的完整原文会提供给{{ candidateTwinCandidate.nickname }}只读查看；
          你已经从联系请求中看到对方的安全候选卡。
        </p>
        <label class="candidate-twin-consent-check" for="candidate-twin-consent">
          <input
            id="candidate-twin-consent"
            v-model="candidateTwinConsent"
            type="checkbox"
          />
          <span>我已知晓完整原文会提供给分身主人，并同意继续</span>
        </label>
        <p v-if="candidateTwinError" class="form-error" role="alert">
          {{ candidateTwinError }}
        </p>
        <div class="candidate-twin-actions">
          <button class="quiet-action" type="button" @click="closeCandidateTwin">
            返回
          </button>
          <button
            class="open-candidate-twin"
            type="button"
            :disabled="!candidateTwinConsent || candidateTwinOpening"
            @click="openCandidateTwin"
          >
            {{ candidateTwinOpening ? "进入中…" : "同意并进入" }}
          </button>
        </div>
      </section>

      <template v-else-if="activeTab === 'recommendations'">
      <p v-if="recommendationsLoading" class="loading-state">正在读取候选…</p>
      <section
        v-else-if="recommendations && !recommendations.eligibility.eligible"
        class="recommendations-empty"
      >
        <h2>分身还没准备好参与推荐</h2>
        <p>请先完善八个关系维度，通过至少 8/10 的校准、确认没有关键事实捏造并主动发布分身。</p>
        <button type="button" @click="showTab('twin')">继续完善我的分身</button>
      </section>
      <template v-else-if="recommendations">
        <section v-if="recommendations.followupQuestions.length" class="matching-followups">
          <h2>还需要了解你</h2>
          <p>这些问题不会暴露任何候选人，只用于补足你的匹配边界。</p>
          <ul>
            <li v-for="item in recommendations.followupQuestions" :key="item.id">
              {{ item.question }}
            </li>
          </ul>
        </section>

        <div class="recommendation-toolbar">
          <p>还可保留 {{ recommendations.remainingCapacity }}/{{ recommendations.capacity }} 位候选</p>
          <button
            v-if="recommendations.dailyFetchAvailable && recommendations.remainingCapacity > 0"
            class="fetch-recommendations"
            type="button"
            :disabled="recommendationsPending"
            @click="fetchRecommendations"
          >
            {{ recommendationsPending ? "评估中…" : "获取今日推荐" }}
          </button>
          <span v-else>{{ recommendations.generating ? "正在评估…" : "今日已获取" }}</span>
        </div>

        <p v-if="recommendations.generating" class="loading-state">配对评估正在后台进行，完成后会自动刷新。</p>
        <section v-else-if="recommendations.candidates.length" class="candidate-list" aria-label="候选推荐列表">
          <article v-for="candidate in recommendations.candidates" :key="candidate.id" class="candidate-card">
            <div class="candidate-heading">
              <span class="candidate-avatar" aria-hidden="true">{{ candidate.avatarText }}</span>
              <div>
                <h2>{{ candidate.nickname }}</h2>
                <p>{{ candidate.age }} 岁 · {{ candidate.heightCm }} cm</p>
                <p>{{ candidate.city }} · {{ candidate.occupation }}</p>
              </div>
            </div>
            <p class="candidate-reason">{{ candidate.reason }}</p>
            <div class="candidate-actions">
              <button
                class="chat-candidate"
                type="button"
                :disabled="recommendationsPending"
                @click="requestCandidateTwin(candidate)"
              >
                与 TA 的恋爱分身聊聊
              </button>
              <button
                class="skip-candidate"
                type="button"
                :disabled="recommendationsPending"
                @click="skipCandidate(candidate.id)"
              >
                跳过这位候选
              </button>
            </div>
          </article>
        </section>
        <section v-else class="recommendations-empty">
          <h2>暂时没有达到条件的候选</h2>
          <p>这里不会展示全市场，也不会用低于最低互惠适合度的人补足数量。</p>
        </section>
      </template>
      </template>
      <p v-if="recommendationsError" class="form-error" role="alert">{{ recommendationsError }}</p>
      <template v-if="activeTab === 'connections'">
        <section class="connections-intro recommendations-intro">
          <p class="step-label">真人联系</p>
          <h1>双方都同意，再开始交流</h1>
          <p>联系请求只披露安全候选卡；同一时间最多保留一段当前联系。</p>
        </section>

        <p v-if="connectionsLoading" class="loading-state">正在读取联系状态…</p>
        <template v-else-if="connections">
          <section
            v-if="connections.currentConnection?.candidate"
            class="current-connection contact-request-card"
          >
            <p class="step-label">当前联系</p>
            <div class="candidate-heading">
              <span class="candidate-avatar" aria-hidden="true">
                {{ connections.currentConnection.candidate.avatarText }}
              </span>
              <div>
                <h2>已与{{ connections.currentConnection.candidate.nickname }}建立联系</h2>
                <p>
                  {{ connections.currentConnection.candidate.age }} 岁 ·
                  {{ connections.currentConnection.candidate.heightCm }} cm
                </p>
                <p>
                  {{ connections.currentConnection.candidate.city }} ·
                  {{ connections.currentConnection.candidate.occupation }}
                </p>
              </div>
            </div>
          </section>

          <section class="contact-request-list" aria-label="收到的联系请求">
            <h2>收到的请求</h2>
            <article
              v-for="contactRequest in connections.incoming"
              :key="contactRequest.id"
              class="contact-request-card"
            >
              <div class="candidate-heading">
                <span class="candidate-avatar" aria-hidden="true">
                  {{ contactRequest.candidate.avatarText }}
                </span>
                <div>
                  <h3>{{ contactRequest.candidate.nickname }}</h3>
                  <p>
                    {{ contactRequest.candidate.age }} 岁 ·
                    {{ contactRequest.candidate.heightCm }} cm
                  </p>
                  <p>
                    {{ contactRequest.candidate.city }} ·
                    {{ contactRequest.candidate.occupation }}
                  </p>
                </div>
                <span class="contact-status">{{ contactStatus(contactRequest.status) }}</span>
              </div>
              <p class="candidate-reason">{{ contactRequest.candidate.reason }}</p>
              <p v-if="contactRequest.conversation" class="contact-conversation-code">
                原匿名会话：会话 {{ contactRequest.conversation.anonymousCode }}
              </p>
              <p v-if="contactRequest.resolutionMessage" class="contact-resolution">
                {{ contactRequest.resolutionMessage }}
              </p>
              <div v-if="contactRequest.status === 'pending'" class="candidate-actions">
                <button
                  class="contact-request-twin"
                  type="button"
                  :disabled="connectionsPending"
                  @click="openRequesterTwin(contactRequest)"
                >
                  先与 TA 的恋爱分身聊聊
                </button>
                <button
                  class="accept-contact-request"
                  type="button"
                  :disabled="connectionsPending"
                  @click="resolveContactRequest(contactRequest, 'accept')"
                >
                  接受请求
                </button>
                <button
                  class="reject-contact-request quiet-action"
                  type="button"
                  :disabled="connectionsPending"
                  @click="resolveContactRequest(contactRequest, 'reject')"
                >
                  拒绝
                </button>
              </div>
            </article>
            <p v-if="!connections.incoming.length" class="empty-state">
              暂时没有收到联系请求。
            </p>
          </section>

          <section class="contact-request-list" aria-label="发出的联系请求">
            <h2>发出的请求</h2>
            <article
              v-for="contactRequest in connections.outgoing"
              :key="contactRequest.id"
              class="contact-request-card"
            >
              <div class="candidate-heading">
                <span class="candidate-avatar" aria-hidden="true">
                  {{ contactRequest.candidate.avatarText }}
                </span>
                <div>
                  <h3>{{ contactRequest.candidate.nickname }}</h3>
                  <p>{{ contactRequest.candidate.city }} · {{ contactRequest.candidate.occupation }}</p>
                </div>
                <span class="contact-status">{{ contactStatus(contactRequest.status) }}</span>
              </div>
              <p v-if="contactRequest.resolutionMessage" class="contact-resolution">
                {{ contactRequest.resolutionMessage }}
              </p>
            </article>
            <p v-if="!connections.outgoing.length" class="empty-state">
              还没有发出联系请求。
            </p>
          </section>
        </template>
        <p v-if="connectionsError" class="form-error" role="alert">
          {{ connectionsError }}
        </p>
      </template>
    </template>

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

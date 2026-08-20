import { createHash } from "node:crypto";

export const PORTRAIT_DIMENSIONS = [
  "long_term_planning",
  "values",
  "relationship_boundaries",
  "communication",
  "conflict_repair",
  "emotional_support",
  "lifestyle",
  "family_and_finance",
] as const;

export type PortraitDimension = (typeof PORTRAIT_DIMENSIONS)[number];

export const FIXED_INTERVIEW_QUESTIONS = [
  {
    id: "future-change",
    dimensions: ["long_term_planning"],
    prompt: "如果未来三年出现一次会改变生活节奏的机会，你通常会怎样决定？",
    options: [
      { id: "plan-together", text: "先和伴侣把共同计划谈清楚，再决定要不要抓住机会" },
      { id: "take-first", text: "机会难得时会先抓住，再想办法协调关系" },
      { id: "keep-stable", text: "更愿意保住已有的稳定，即使因此放弃一些机会" },
      { id: "depends", text: "有时很果断，有时会拖很久，取决于当时的安全感" },
    ],
  },
  {
    id: "values-disagreement",
    dimensions: ["values"],
    prompt: "当伴侣在一件重要事情上的判断与你不同，你更可能怎么面对？",
    options: [
      { id: "understand-first", text: "先弄清楚对方为何这样判断，再看能否共存" },
      { id: "persuade", text: "会努力说服对方，因为有些判断不能含糊" },
      { id: "avoid", text: "不太想争，能绕开就先绕开" },
      { id: "mixed", text: "口头上说尊重差异，心里可能仍会介意很久" },
    ],
  },
  {
    id: "personal-boundary",
    dimensions: ["relationship_boundaries"],
    prompt: "进入稳定关系后，你怎样看待彼此仍保留个人空间？",
    options: [
      { id: "clear-space", text: "需要明确的独处时间，也尊重对方有自己的生活" },
      { id: "share-most", text: "更希望大部分事情都彼此参与，分得太开会不安" },
      { id: "no-rule", text: "不想先定规则，遇到具体事情再商量" },
      { id: "uneven", text: "希望对方给我空间，但对方疏远时我也容易多想" },
    ],
  },
  {
    id: "hard-conversation",
    dimensions: ["communication"],
    prompt: "有件可能让伴侣不舒服的事需要说时，你通常会怎么开口？",
    options: [
      { id: "direct-gentle", text: "尽量直接说清楚，同时照顾措辞和时机" },
      { id: "hint", text: "先试探或暗示，希望对方自己意识到" },
      { id: "delay", text: "容易拖着不说，直到情绪或事情逼到眼前" },
      { id: "message", text: "面对面难说时，更愿意先用文字整理清楚" },
    ],
  },
  {
    id: "after-conflict",
    dimensions: ["conflict_repair"],
    prompt: "一次争执结束后，什么更像你恢复关系的方式？",
    options: [
      { id: "review", text: "冷静后会复盘发生了什么，并谈下次怎么处理" },
      { id: "affection", text: "先恢复日常和亲近感，具体问题之后再说" },
      { id: "distance", text: "需要比较长的时间独处，不希望被催着和好" },
      { id: "pretend", text: "常常表现得已经没事，但心里还留着旧账" },
    ],
  },
  {
    id: "emotional-support",
    dimensions: ["emotional_support"],
    prompt: "伴侣情绪低落但说不清原因时，你更自然的反应是什么？",
    options: [
      { id: "listen", text: "先陪着听，不急着解决问题" },
      { id: "solve", text: "会分析原因并给出可以执行的办法" },
      { id: "space", text: "给对方空间，等对方准备好再来找我" },
      { id: "overwhelmed", text: "很想帮忙，但持续的负面情绪也会让我想逃开" },
    ],
  },
  {
    id: "daily-rhythm",
    dimensions: ["lifestyle"],
    prompt: "理想的共同生活里，日常节奏更接近哪种状态？",
    options: [
      { id: "routine", text: "作息和安排相对稳定，提前计划会让我安心" },
      { id: "spontaneous", text: "保留变化和临时起意，不想把生活排得太满" },
      { id: "parallel", text: "住在一起也可以各忙各的，不必总同步" },
      { id: "wish-routine", text: "喜欢稳定的想象，但现实里经常打乱计划" },
    ],
  },
  {
    id: "family-finance",
    dimensions: ["family_and_finance"],
    prompt: "长期关系中的家庭责任与金钱安排，你更倾向怎样组织？",
    options: [
      { id: "shared-plan", text: "共同做预算和分工，重要决定双方都参与" },
      { id: "independent", text: "各自负责自己的部分，尽量少互相干涉" },
      { id: "strengths", text: "谁更擅长谁多负责，不必事事平均" },
      { id: "avoid-detail", text: "认同应该谈清楚，但真谈到数字和责任时会有压力" },
    ],
  },
  {
    id: "loyalty-tension",
    dimensions: ["values", "relationship_boundaries"],
    prompt: "伴侣与自己的家人或好友发生明显分歧时，你更可能站在哪里？",
    options: [
      { id: "partner-public", text: "对外先和伴侣站在一起，私下再讨论谁更有道理" },
      { id: "facts", text: "按事情本身判断，不会因为关系亲近就偏向谁" },
      { id: "mediate", text: "尽量调和双方，哪边都不想得罪" },
      { id: "different-cases", text: "嘴上说看事实，但面对家人时可能做不到完全中立" },
    ],
  },
  {
    id: "shared-future-cost",
    dimensions: ["long_term_planning", "family_and_finance", "lifestyle"],
    prompt: "一项对共同未来有帮助、但会让当下生活变紧的计划出现时，你会怎么衡量？",
    options: [
      { id: "accept-cost", text: "只要目标一致，愿意一起承受一段时间的不方便" },
      { id: "protect-now", text: "不会为了很远的目标持续牺牲现在的生活质量" },
      { id: "small-trial", text: "先做小规模尝试，看到效果再增加投入" },
      { id: "agree-then-stop", text: "容易被未来打动而答应，执行一阵后又想停下来" },
    ],
  },
] as const satisfies readonly {
  id: string;
  dimensions: readonly PortraitDimension[];
  prompt: string;
  options: readonly { id: string; text: string }[];
}[];

export function publicQuestion(memberId: string, index: number) {
  const question = FIXED_INTERVIEW_QUESTIONS[index];
  if (!question) return null;
  return {
    id: question.id,
    number: index + 1,
    prompt: question.prompt,
    options: question.options
      .map((option) => ({
        ...option,
        order: createHash("sha256")
          .update(`${memberId}:${question.id}:${option.id}`)
          .digest("hex"),
      }))
      .sort((left, right) => left.order.localeCompare(right.order))
      .map(({ order: _order, ...option }) => option),
  };
}

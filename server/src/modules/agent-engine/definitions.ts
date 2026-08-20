export const portraitInterviewerDefinition = {
  role: "portrait_interviewer" as const,
  task: "continue_interview" as const,
  version: "portrait-interviewer-v1",
  promptVersion: "portrait-interviewer-prompt-v1",
  schemaVersion: null,
  allowedTools: [],
  systemPrompt:
    "你是 OnlyLove 的私有画像访谈员。你的任务是通过自然、具体且不诱导的追问，逐步理解成员在长期关系中的判断、边界和表达方式。一次只追问一个重点；不要诊断、打分或替成员下结论；不要声称自己是成员的恋爱分身。",
};

export const portraitExtractorDefinition = {
  role: "portrait_extractor" as const,
  task: "extract_portrait" as const,
  version: "portrait-extractor-v1",
  promptVersion: "portrait-extractor-prompt-v1",
  schemaVersion: "portrait-extractor-schema-v1",
  allowedTools: [],
  systemPrompt:
    "你是 OnlyLove 的画像提取器。只根据提供的访谈材料返回请求 Schema 对应的 JSON，不输出解释或 Markdown。",
};

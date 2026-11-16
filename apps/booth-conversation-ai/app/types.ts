export type Visitor = {
  id: string;
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  createdAt: string;
};

export type VisitorInput = Omit<Visitor, "id" | "createdAt">;

export type LeadScore = {
  scores: {
    interest: number;
    budget: number;
    authority: number;
    timeline: number;
  };
  overallScore: number;
  recommendation: string;
  summary: string;
};

export type EmailDraft = {
  subject: string;
  body: string;
};

export type LeadScoreDimensions = LeadScore["scores"];

export type CrmExport = {
  id: string;
  visitor: Visitor;
  conversationText: string;
  scores: LeadScore;
  emailDraft: EmailDraft;
  exportedAt: string;
};

export type CrmExportResult = { success: true; exportedAt: string; recordId: string };
export type ConversationAudio = { blob: Blob; recognizedText: string };

import { useState, useCallback, useRef, useEffect } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation, useSearch } from "wouter";
import { safeGetLoginUrl } from "@/const";
import { motion, AnimatePresence } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Search,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  ArrowDown,
  Tag,
  Lightbulb,
  ShieldAlert,
  RefreshCw,
  Clock,
  Database,
  BookOpen,
  Edit2,
  Lock,
  LogIn,
  LogOut,
  User,
  Users,
  Building2,
} from "lucide-react";
import type { AnalysisReport, KeywordAnalysis, NegativeInsightGroup, SearchTermReport } from "../../../shared/types";
import { SearchTermUploader } from "@/components/SearchTermUploader";
import { SearchTermPreview } from "@/components/SearchTermPreview";
import { SearchTermResults } from "@/components/SearchTermResults";
import { useCSVParser } from "../hooks/useCSVParser";
import { useSearchTermQueue } from "../hooks/useSearchTermQueue";
import type { CSVParseResult } from "../hooks/useCSVParser";
import { FileSearch } from "lucide-react";

export default function Home() {
  const { user, isAuthenticated, logout, loading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const searchString = useSearch();

  // Parse clientId from URL query params (?clientId=xxx)
  const urlClientId = (() => {
    const params = new URLSearchParams(searchString);
    const v = params.get("clientId");
    return v ? Number(v) : null;
  })();

  // Fetch client profile when clientId is in URL (Scene A)
  const { data: clientProfile } = trpc.clients.getById.useQuery(
    { id: urlClientId! },
    { enabled: !!urlClientId && isAuthenticated }
  );

  const [businessDirection, setBusinessDirection] = useState("");
  const [businessType, setBusinessType] = useState<"B2B" | "B2C">("B2B");
  const [model, setModel] = useState<string>("deepseek-v4-flash");
  const [keywordInput, setKeywordInput] = useState("");
  // Persist report in sessionStorage to survive HMR / page reconnects
  // The stored value is wrapped with the clientId so we can discard stale reports
  // from a different client when the user navigates to a new ?clientId=xxx URL.
  const [report, setReportState] = useState<AnalysisReport | null>(() => {
    try {
      const savedClientId = sessionStorage.getItem("sem_report_client_id");
      const saved = sessionStorage.getItem("sem_report");
      if (!saved) return null;
      // If the page loaded with a specific clientId, only restore if it matches
      const params = new URLSearchParams(window.location.search);
      const pageClientId = params.get("clientId");
      if (pageClientId && savedClientId !== pageClientId) {
        sessionStorage.removeItem("sem_report");
        sessionStorage.removeItem("sem_report_client_id");
        return null;
      }
      return JSON.parse(saved) as AnalysisReport;
    } catch {
      return null;
    }
  });
  const setReport = useCallback((r: AnalysisReport | null) => {
    setReportState(r);
    try {
      if (r) {
        sessionStorage.setItem("sem_report", JSON.stringify(r));
        // Also persist the current clientId so we can validate on next load
        const params = new URLSearchParams(window.location.search);
        const pageClientId = params.get("clientId");
        if (pageClientId) sessionStorage.setItem("sem_report_client_id", pageClientId);
        else sessionStorage.removeItem("sem_report_client_id");
      } else {
        sessionStorage.removeItem("sem_report");
        sessionStorage.removeItem("sem_report_client_id");
      }
    } catch { /* ignore quota errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [formCollapsed, setFormCollapsed] = useState<boolean>(() => {
    try { return sessionStorage.getItem("sem_form_collapsed") === "true"; }
    catch { return false; }
  });
  const setFormCollapsedPersist = useCallback((v: boolean) => {
    setFormCollapsed(v);
    try { sessionStorage.setItem("sem_form_collapsed", String(v)); } catch { /* ignore */ }
  }, []);
  const [copiedKeep, setCopiedKeep] = useState(false);
  const [copiedExclude, setCopiedExclude] = useState(false);
  const [negativeMatchMode, setNegativeMatchMode] = useState<"broad" | "phrase" | "exact">("broad");
  // Selection state for keep/exclude sections
  const [selectedKeep, setSelectedKeep] = useState<Set<string>>(new Set());
  const [selectedExclude, setSelectedExclude] = useState<Set<string>>(new Set());
  const reportRef = useRef<HTMLDivElement>(null);

  // Search Term (CSV) mode state
  const [csvParseResult, setCsvParseResult] = useState<CSVParseResult | null>(null);
  const [showSearchTermResults, setShowSearchTermResults] = useState(false);
  const [csvCurrentPage, setCsvCurrentPage] = useState(0); // 0-indexed, tracks which page was last analyzed
  const { queue, initQueue, startAutoAnalysis, resetQueue, hasMore, remainingQuota, canContinue, loadSavedPage, getSavedPageList } = useSearchTermQueue();
  // Saved page results for viewing previously analyzed pages without re-running
  const [savedPageResults, setSavedPageResults] = useState<import('../../../shared/types').SearchTermAnalysis[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const formatNegativeKeyword = useCallback((keyword: string, mode: "broad" | "phrase" | "exact") => {
    if (mode === "phrase") return `"${keyword}"`;
    if (mode === "exact") return `[${keyword}]`;
    return keyword; // broad match - no formatting
  }, []);

  // Simulate progress while waiting for the API
  const startProgress = useCallback((keywordCount: number) => {
    setProgress(0);
    const stages = [
      { label: `正在初始化分析任务（${keywordCount} 个关键词）...`, target: 20, duration: 2000 },
      { label: "AI 语义分析中...", target: 70, duration: 8000 },
      { label: "生成分析报告...", target: 88, duration: 3000 },
      { label: "提取智能否词建议...", target: 95, duration: 2000 },
    ];
    let stageIndex = 0;
    let currentProgress = 0;

    const tick = () => {
      if (stageIndex >= stages.length) return;
      const stage = stages[stageIndex]!;
      setProgressLabel(stage.label);
      const step = (stage.target - currentProgress) / (stage.duration / 100);
      const interval = setInterval(() => {
        currentProgress = Math.min(stage.target, currentProgress + step);
        setProgress(Math.round(currentProgress));
        if (currentProgress >= stage.target) {
          clearInterval(interval);
          stageIndex++;
          if (stageIndex < stages.length) {
            setTimeout(tick, 200);
          }
        }
      }, 100);
      progressTimerRef.current = interval;
    };
    tick();
  }, []);

  const stopProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgress(100);
    setProgressLabel("分析完成！");
  }, []);

  const analyzeMutation = trpc.keyword.analyze.useMutation({
    onSuccess: (data) => {
      stopProgress();
      const reportData = data as AnalysisReport & { fromCache?: boolean };
      setFromCache(reportData.fromCache ?? false);
      setReport(reportData);
      setFormCollapsedPersist(true);
      // Clear selections on new analysis
      setSelectedKeep(new Set());
      setSelectedExclude(new Set());
      // Exit CSV mode so the report section is not hidden behind the CSV preview
      setCsvParseResult(null);
      setShowSearchTermResults(false);
      setSavedPageResults(null);
      resetQueue();
      // Scroll to report after animation
      setTimeout(() => {
        reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 400);
    },
    onError: (error) => {
      stopProgress();
      // Detect gateway timeout (504) or JSON-parse failure from HTML error page
      const msg = error.message ?? "";
      const isGatewayError =
        msg.includes("Unexpected token") ||
        msg.includes("504") ||
        msg.includes("502") ||
        msg.includes("Gateway") ||
        msg.includes("not valid JSON");
      if (isGatewayError) {
        toast.error(
          "请求超时，请减少单次提交的关键词数量（建议 50 个以内）并重试。",
          { duration: 6000 }
        );
      } else {
        toast.error("分析失败: " + error.message);
      }
    },
  });

  // Search Term mutation
  const analyzeSearchTermsMutation = trpc.searchTerm.analyzeSearchTerms.useMutation();

  // Handler: CSV parsed → show preview
  const handleCsvParsed = useCallback((result: CSVParseResult) => {
    setCsvParseResult(result);
    setShowSearchTermResults(false);
  }, []);

  // Handler: start analysis from preview — auto-runs all pages
  const handleStartSearchTermAnalysis = useCallback((rows: import('../hooks/useCSVParser').SearchTermRow[], page: number) => {
    if (!urlClientId || !user) return;
    setCsvCurrentPage(page);
    setSavedPageResults(null);
    initQueue({
      rows,
      businessDirection: businessDirection.trim(),
      businessType,
      clientId: urlClientId,
      initialQuota: { count: user.daily_keyword_count ?? 0, limit: user.daily_keyword_limit ?? 1000 },
      pageIndex: page,
    });
    setShowSearchTermResults(true);
    setFormCollapsedPersist(true);
    setTimeout(() => {
      startAutoAnalysis(analyzeSearchTermsMutation.mutateAsync as any);
    }, 50);
  }, [urlClientId, user, businessDirection, businessType, initQueue, startAutoAnalysis, analyzeSearchTermsMutation.mutateAsync, setFormCollapsedPersist]);

  // Handler: continue next batch (manual trigger after pause/error)
  const handleContinueSearchTermAnalysis = useCallback(() => {
    startAutoAnalysis(analyzeSearchTermsMutation.mutateAsync as any);
  }, [startAutoAnalysis, analyzeSearchTermsMutation.mutateAsync]);

  // Handler: reset CSV mode
  const handleResetSearchTermMode = useCallback(() => {
    setCsvParseResult(null);
    setShowSearchTermResults(false);
    setCsvCurrentPage(0);
    setSavedPageResults(null);
    resetQueue();
  }, [resetQueue]);

  // Internal: actually fire the analyze mutation
  const fireAnalyze = useCallback(
    (keywords: string[], opts?: { clientId?: number; saveAsClient?: { name: string } }) => {
      setFromCache(false);
      startProgress(keywords.length);
      analyzeMutation.mutate({
        businessDirection: businessDirection.trim(),
        businessType,
        keywords,
        model,
        clientId: opts?.clientId,
        saveAsClient: opts?.saveAsClient,
      });
    },
    [businessDirection, businessType, analyzeMutation, startProgress]
  );

  const handleSubmit = useCallback(() => {
    const keywords = keywordInput
      .split(/[,，\n]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    // Clear old report when starting a new analysis
    setReport(null);
    if (!businessDirection.trim()) {
      toast.error("请输入客户的业务方向");
      return;
    }
    if (keywords.length === 0) {
      toast.error("请输入至少一个关键词");
      return;
    }
    if (keywords.length > 100) {
      toast.error("单次最多分析 100 个关键词");
      return;
    }

    // Scene A: clientId in URL — fire directly with clientId for dedup
    if (urlClientId) {
      fireAnalyze(keywords, { clientId: urlClientId });
      return;
    }

    // Scene B: no clientId — intercept and ask user
    setPendingKeywords(keywords);
    setSaveClientName("");
    setSaveClientChoice(null);
    setShowSaveAsClientDialog(true);
  }, [businessDirection, businessType, keywordInput, urlClientId, fireAnalyze]);

  const copyKeywords = useCallback(
    (type: "keep" | "exclude") => {
      if (!report) return;
      const selectedSet = type === "keep" ? selectedKeep : selectedExclude;
      const hasSelection = selectedSet.size > 0;

      const keywords = report.results
        .filter((r) => r.recommendation === type)
        .filter((r) => !hasSelection || selectedSet.has(r.keyword))
        .map((r) => type === "exclude" ? formatNegativeKeyword(r.keyword, negativeMatchMode) : r.keyword)
        .join("\n");

      navigator.clipboard.writeText(keywords).then(() => {
        if (type === "keep") {
          setCopiedKeep(true);
          setTimeout(() => setCopiedKeep(false), 2000);
        } else {
          setCopiedExclude(true);
          setTimeout(() => setCopiedExclude(false), 2000);
        }
        const modeLabel = type === "exclude" ? {
          broad: "广泛匹配",
          phrase: "词组匹配",
          exact: "完全匹配",
        }[negativeMatchMode] : "";
        const countLabel = hasSelection ? `${selectedSet.size} 个所选` : "全部";
        toast.success(
          `已复制 ${type === "keep" ? "建议保留" : `建议排除（${modeLabel}）`} ${countLabel}关键词`
        );
      });
    },
    [report, negativeMatchMode, formatNegativeKeyword, selectedKeep, selectedExclude]
  );

  // Per-group copy state: key = category name
  const [copiedGroups, setCopiedGroups] = useState<Record<string, boolean>>({});

  const copyInsightGroup = useCallback(
    (group: NegativeInsightGroup) => {
      const text = group.terms.join("\n");
      navigator.clipboard.writeText(text).then(() => {
        setCopiedGroups((prev) => ({ ...prev, [group.category]: true }));
        setTimeout(() => {
          setCopiedGroups((prev) => ({ ...prev, [group.category]: false }));
        }, 2000);
        toast.success(`已复制「${group.category}」广泛匹配否词 ${group.terms.length} 个`);
      });
    },
    []
  );

  // Scene A: auto-fill business fields from client profile when clientId is in URL
  useEffect(() => {
    if (clientProfile) {
      setBusinessDirection(clientProfile.businessDirection);
      setBusinessType(clientProfile.businessType as "B2B" | "B2C");
    }
  }, [clientProfile]);

  // When the active client changes, clear any stale CSV analysis state to prevent
  // cross-client result pollution.
  // IMPORTANT: Only clear when switching between two *different valid* client IDs.
  // Avoid triggering on null-flicker (e.g. 123 -> null -> 123) caused by URL
  // query string briefly disappearing during navigation, which would wipe a
  // freshly-set report and make the result section invisible.
  const prevClientIdRef = useRef<number | null>(null);
  const isValidClientId = (v: number | null): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  useEffect(() => {
    const prev = prevClientIdRef.current;
    const next = urlClientId;
    if (isValidClientId(prev) && isValidClientId(next) && prev !== next) {
      // Client truly switched — wipe all analysis state to prevent cross-client pollution
      setCsvParseResult(null);
      setShowSearchTermResults(false);
      setCsvCurrentPage(0);
      setSavedPageResults(null);
      resetQueue();
      // Also clear the main keyword analysis report so the new client starts fresh
      setReport(null);
      setKeywordInput("");
    }
    prevClientIdRef.current = next;
  // setReport is a stable useCallback, no need to list it as a dependency
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlClientId, resetQueue]);

  // Scene B: save-as-client modal state
  const [showSaveAsClientDialog, setShowSaveAsClientDialog] = useState(false);
  const [pendingKeywords, setPendingKeywords] = useState<string[]>([]);
  const [saveClientName, setSaveClientName] = useState("");
  const [saveClientChoice, setSaveClientChoice] = useState<"direct" | "save" | null>(null);

  // 未登录提示弹窗：auth 加载完成后，若未登录则弹出
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setShowLoginPrompt(true);
    }
  }, [authLoading, isAuthenticated]);

  const handleLoginPromptConfirm = useCallback(() => {
    setShowLoginPrompt(false);
    const url = safeGetLoginUrl();
    if (url) window.location.href = url;
  }, []);

  const [showReadme, setShowReadme] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isEditMode, setIsEditMode] = useState(false);
  const [isEditLoading, setIsEditLoading] = useState(false);
  const [readmeContent, setReadmeContent] = useState("");

  // 动态加载 README 内容
  const { data: readmeData } = trpc.keyword.getReadme.useQuery(undefined, {
    staleTime: Infinity,
  });
  useEffect(() => {
    if (readmeData?.content) {
      setReadmeContent(readmeData.content);
    }
  }, [readmeData]);

  const editMutation = trpc.keyword.editReadme.useMutation({
    onSuccess: () => {
      toast.success("使用指引已更新");
      setShowEditDialog(false);
      setEditPassword("");
      setEditContent("");
      setIsEditMode(false);
      setIsEditLoading(false);
      setReadmeContent(editContent);
      setShowReadme(false);
      setTimeout(() => setShowReadme(true), 100);
    },
    onError: (error) => {
      setIsEditLoading(false);
      toast.error("更新失败: " + error.message);
    },
  });

  const handleEditClick = () => {
    setEditPassword("");
    setEditContent(readmeContent);
    setShowEditDialog(true);
  };

  const handlePasswordSubmit = () => {
    if (!editPassword.trim()) {
      toast.error("请输入密码");
      return;
    }
    setIsEditMode(true);
  };

  const handleSaveEdit = () => {
    if (!editContent.trim()) {
      toast.error("内容不能为空");
      return;
    }
    setIsEditLoading(true);
    editMutation.mutate({
      password: editPassword,
      content: editContent,
    });
  };

  const keepResults = report?.results.filter((r) => r.recommendation === "keep") || [];
  const excludeResults = report?.results.filter((r) => r.recommendation === "exclude") || [];

  // Derived: count of currently parsed keywords for the >50 warning
  const parsedKeywordCount = keywordInput
    .split(/[,，\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0).length;

  const handleForceRefresh = useCallback(() => {
    const keywords = keywordInput
      .split(/[,，\n]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (!businessDirection.trim() || keywords.length === 0) return;
    setFromCache(false);
    startProgress(keywords.length);
    analyzeMutation.mutate({
      businessDirection: businessDirection.trim(),
      businessType,
      keywords,
      forceRefresh: true,
      clientId: urlClientId ?? undefined,
    });
  }, [businessDirection, businessType, keywordInput, urlClientId, analyzeMutation, startProgress]);

  return (
    <div className="min-h-screen apple-gradient-bg flex flex-col">
      {/* Scene B: Save-as-client dialog */}
      <AlertDialog open={showSaveAsClientDialog} onOpenChange={setShowSaveAsClientDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" />
              是否保存为客户档案？
            </AlertDialogTitle>
            <AlertDialogDescription>
              保存后，系统将记录本次分析的关键词历史，下次为该客户分析时自动跳过已处理的词。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {saveClientChoice === "save" && (
            <div className="py-2">
              <label className="text-sm font-medium text-foreground block mb-1.5">客户名称</label>
              <Input
                placeholder="例如：ABC 工业自动化"
                value={saveClientName}
                onChange={(e) => setSaveClientName(e.target.value)}
                className="rounded-xl"
                autoFocus
              />
            </div>
          )}
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel
              onClick={() => {
                setShowSaveAsClientDialog(false);
                setSaveClientChoice(null);
              }}
            >
              取消
            </AlertDialogCancel>
            {saveClientChoice !== "save" ? (
              <>
                <AlertDialogAction
                  onClick={() => {
                    setShowSaveAsClientDialog(false);
                    setSaveClientChoice(null);
                    setReport(null);
                    fireAnalyze(pendingKeywords);
                  }}
                  className="bg-secondary text-foreground hover:bg-secondary/80"
                >
                  直接分析
                </AlertDialogAction>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    setSaveClientChoice("save");
                  }}
                >
                  保存并分析
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                onClick={() => {
                  if (!saveClientName.trim()) {
                    toast.error("请输入客户名称");
                    return;
                  }
                  setShowSaveAsClientDialog(false);
                  setSaveClientChoice(null);
                  setReport(null);
                  fireAnalyze(pendingKeywords, { saveAsClient: { name: saveClientName.trim() } });
                }}
              >
                确认保存并分析
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Readme Dialog */}
      <Dialog open={showReadme} onOpenChange={setShowReadme}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden rounded-2xl">
          <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/30 shrink-0 flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <BookOpen className="w-4 h-4 text-primary" />
              使用指引
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleEditClick}
              className="gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Edit2 className="w-3.5 h-3.5" />
              编辑
            </Button>
          </DialogHeader>
          <ScrollArea className="flex-1 overflow-auto">
            <div className="px-6 py-5 prose prose-sm max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{readmeContent}</ReactMarkdown>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Edit README Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden rounded-2xl">
          <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/30 shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Edit2 className="w-4 h-4 text-primary" />
              编辑使用指引
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 overflow-auto">
            <div className="px-6 py-5 space-y-4">
              {!isEditMode ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2 flex items-center gap-2">
                      <Lock className="w-4 h-4" />
                      管理员密码
                    </label>
                    <Input
                      type="password"
                      placeholder="请输入管理员密码"
                      value={editPassword}
                      onChange={(e) => setEditPassword(e.target.value)}
                      className="rounded-lg"
                    />
                  </div>
                  <Button
                    onClick={handlePasswordSubmit}
                    className="w-full bg-primary hover:bg-primary/90 text-white rounded-lg"
                  >
                    验证密码
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="min-h-[400px] font-mono text-sm rounded-lg resize-none"
                    placeholder="编辑 Markdown 内容..."
                  />
                </div>
              )}
            </div>
          </ScrollArea>
          {isEditMode && (
            <DialogFooter className="px-6 py-4 border-t border-border/30 shrink-0 flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditMode(false);
                  setShowEditDialog(false);
                }}
                className="rounded-lg"
              >
                取消
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={isEditLoading}
                className="bg-primary hover:bg-primary/90 text-white rounded-lg"
              >
                {isEditLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    保存中...
                  </>
                ) : (
                  "保存"
                )}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* 未登录提示弹窗 */}
      <AlertDialog open={showLoginPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请登录系统</AlertDialogTitle>
            <AlertDialogDescription>
              请使用公司邮箱@yeehaiglobal 以注册并登录本系统~
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={handleLoginPromptConfirm}>
              前往登录
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Header */}
      <header className="w-full py-5 px-6">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[oklch(0.55_0.2_260)] to-[oklch(0.45_0.22_280)] flex items-center justify-center">
              <Search className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              SEM Keyword Pro
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {isAuthenticated && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/clients")}
                  className="gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-xl"
                >
                  <Users className="w-3.5 h-3.5" />
                  我的客户
                </Button>

              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowReadme(true)}
              className="gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-xl"
            >
              <BookOpen className="w-3.5 h-3.5" />
              使用指引
            </Button>
            {!authLoading && (
              isAuthenticated ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <User className="w-3.5 h-3.5" />
                    <span className="max-w-[80px] truncate">{user?.name ?? "用户"}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={logout}
                    className="gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-xl"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    登出
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const url = safeGetLoginUrl();
                    if (url) window.location.href = url;
                  }}
                  className="gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-xl"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  登录
                </Button>
              )
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center px-4 pb-8">
        {/* Scene A: Client profile banner */}
        {clientProfile && (
          <div className="w-full max-w-2xl mb-4 mt-2">
            <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-primary/8 border border-primary/20">
              <Building2 className="w-4 h-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-primary">{clientProfile.name}</span>
                <span className="text-xs text-muted-foreground ml-2">已关联客户档案，业务字段已自动填充并锁定</span>
              </div>
              <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                clientProfile.businessType === "B2B"
                  ? "bg-blue-100 text-blue-700"
                  : "bg-purple-100 text-purple-700"
              }`}>
                {clientProfile.businessType}
              </span>
            </div>
          </div>
        )}

        {/* Hero Section - only show when no report */}
        <AnimatePresence>
          {!report && !analyzeMutation.isPending && (
            <motion.div
              initial={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center mt-12 mb-8"
            >
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-3">
                  智能关键词筛选
                </h2>
                <p className="text-muted-foreground text-base max-w-lg mx-auto leading-relaxed">
                  基于 AI 深度语义分析，精准判断关键词与客户业务方向及受众类型的匹配度
                </p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input Form */}
        <motion.div
          layout
          className="w-full max-w-2xl"
          animate={{
            marginTop: formCollapsed ? "0.5rem" : report ? "0.5rem" : "0rem",
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
          <motion.div
            layout
            className="glass-card overflow-hidden"
            animate={{
              padding: formCollapsed ? "0px" : "24px",
            }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            {/* Collapsed header - click to expand */}
            {formCollapsed && (
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                onClick={() => setFormCollapsedPersist(false)}
                className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-accent/50 transition-colors rounded-2xl"
              >
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                    <Search className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div className="text-left">
                    <span className="text-sm font-medium text-foreground">
                      {businessDirection}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {businessType} · {report?.input.keywords.length || 0} 个关键词
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-xs">修改条件</span>
                  <ChevronDown className="w-4 h-4" />
                </div>
              </motion.button>
            )}

            {/* Expanded form */}
            <AnimatePresence>
              {!formCollapsed && (
                <motion.div
                  initial={report ? { opacity: 0, height: 0 } : { opacity: 1 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  {/* Collapse button when report exists */}
                  {report && (
                    <div className="flex justify-end mb-2 px-5 pt-4">
                      <button
                        onClick={() => setFormCollapsedPersist(true)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span>收起</span>
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  <div className={`space-y-5 ${report ? "px-5 pb-5" : ""}`}>
                    {/* Business Direction */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        客户业务方向
                      </label>
                      <input
                        type="text"
                        value={businessDirection}
                        onChange={(e) => !clientProfile && setBusinessDirection(e.target.value)}
                        readOnly={!!clientProfile}
                        placeholder="例如：工业自动化设备制造、跨境电商物流服务..."
                        className={`w-full px-4 py-3 rounded-xl border text-foreground placeholder:text-muted-foreground/60 transition-all text-sm ${
                          clientProfile
                            ? "bg-secondary/30 border-border/30 cursor-not-allowed opacity-70"
                            : "bg-secondary/50 border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50"
                        }`}
                      />
                    </div>

                    {/* Business Type */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        业务类型
                      </label>
                      <div className="flex gap-2">
                        {(["B2B", "B2C"] as const).map((type) => (
                          <button
                            key={type}
                            onClick={() => !clientProfile && setBusinessType(type)}
                            disabled={!!clientProfile}
                            className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition-all ${clientProfile ? "cursor-not-allowed opacity-60 " : ""}${
                              businessType === type
                                ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border border-border/50"
                            }`}
                          >
                            {type}
                            <span className="text-xs ml-1 opacity-70">
                              {type === "B2B" ? "企业端" : "消费端"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Model Selector */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-foreground">
                        AI 模型
                      </label>
                      <div className="flex gap-2">
                        {([
                          { id: "deepseek-v4-flash", label: "Flash", desc: "快速·省 Token" },
                          { id: "deepseek-v4-pro", label: "Pro", desc: "高精度" },
                        ] as const).map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => setModel(opt.id)}
                            className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition-all ${
                              model === opt.id
                                ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border border-border/50"
                            }`}
                          >
                            {opt.label}
                            <span className="text-xs ml-1 opacity-70">{opt.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Keywords Input */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-foreground">
                          待检索关键词
                        </label>
                        <span className="text-xs text-muted-foreground">
                          用逗号或换行分隔，最多 100 个
                        </span>
                      </div>
                      <textarea
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        placeholder={"输入关键词，例如：\nindustrial automation\nPLC controller\nfactory equipment"}
                        rows={4}
                        className="w-full px-4 py-3 rounded-xl bg-secondary/50 border border-border/50 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all text-sm resize-none"
                      />
                    </div>

                    {/* Quota Display */}
                    {isAuthenticated && user && (
                      <div className="px-4 py-3 rounded-xl bg-blue-50 border border-blue-200">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-blue-900 font-medium">
                            {user.role === "admin"
                              ? "今日剩余额度：无限制"
                              : `今日剩余否词额度：${Math.max(0, (user.daily_keyword_limit || 1000) - (user.daily_keyword_count || 0))} / ${user.daily_keyword_limit || 1000}`}
                          </span>
                          {user.role !== "admin" && (user.daily_keyword_count || 0) >= (user.daily_keyword_limit || 1000) && (
                            <span className="text-xs text-red-600 font-semibold">已达上限</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Over-50 keyword warning */}
                    {parsedKeywordCount > 50 && (
                      <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
                        <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                        <div>
                          <p className="text-xs font-semibold text-amber-800">当前已输入 {parsedKeywordCount} 个关键词</p>
                          <p className="text-xs text-amber-700 mt-0.5">建议单次提交不超过 50 个，过多关键词可能导致请求超时。请考虑分批提交。</p>
                        </div>
                      </div>
                    )}

                    {/* Import Search Term Report Button */}
                    {isAuthenticated && (
                      <SearchTermUploader clientId={urlClientId} onParsed={handleCsvParsed}>
                        <Button
                          variant="outline"
                          className="w-full h-10 rounded-xl text-sm font-medium gap-2 border-dashed border-2 hover:border-primary hover:text-primary transition-colors"
                        >
                          <FileSearch className="w-4 h-4" />
                          导入搜索字词报告（CSV）
                        </Button>
                      </SearchTermUploader>
                    )}

                    {/* Submit Button */}
                    <Button
                      onClick={handleSubmit}
                      disabled={analyzeMutation.isPending || (isAuthenticated && user ? user.role !== "admin" && (user.daily_keyword_count || 0) >= (user.daily_keyword_limit || 1000) : false)}
                      className="w-full py-3 h-12 rounded-xl text-sm font-medium shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      title={isAuthenticated && user && user.role !== "admin" && (user.daily_keyword_count || 0) >= (user.daily_keyword_limit || 1000) ? "已到达单日否词分析上限，额度次日清零。" : ""}
                    >
                      {analyzeMutation.isPending ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          AI 正在深度分析中...
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4" />
                          开始智能分析
                        </span>
                      )}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>

        {/* Search Term CSV Preview */}
        {csvParseResult && !showSearchTermResults && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-2xl mt-6"
          >
            <div className="glass-card p-6">
              <div className="flex items-center gap-2 mb-5">
                <FileSearch className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">数据清洗与预览</h3>
              </div>
              <SearchTermPreview
                parseResult={csvParseResult}
                onStartAnalysis={handleStartSearchTermAnalysis}
                onCancel={handleResetSearchTermMode}
                initialPage={csvCurrentPage}
                clientId={urlClientId}
                loadSavedPage={loadSavedPage}
                getSavedPageList={getSavedPageList}
                onViewSavedPage={(pageIndex, results) => {
                  setCsvCurrentPage(pageIndex);
                  // Restore queue state from saved results so SearchTermResults can display them
                  const activeRows = csvParseResult
                    ? csvParseResult.rows.slice(pageIndex * 100, (pageIndex + 1) * 100).filter((r) => !r.excluded)
                    : [];
                  initQueue({
                    rows: activeRows,
                    businessDirection: businessDirection.trim(),
                    businessType,
                    clientId: urlClientId!,
                    initialQuota: { count: user?.daily_keyword_count ?? 0, limit: user?.daily_keyword_limit ?? 1000 },
                    pageIndex,
                  });
                  // Manually inject saved results into queue via a workaround:
                  // We set showSearchTermResults=true; SearchTermResults will receive results from prop
                  setSavedPageResults(results);
                  setShowSearchTermResults(true);
                }}
              />
            </div>
          </motion.div>
        )}

        {/* Search Term Results */}
        {showSearchTermResults && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-2xl mt-6"
          >
            <div className="glass-card p-6">
              <div className="flex items-center gap-2 mb-5">
                <FileSearch className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">三维漏斗诊断结果</h3>
              </div>
              <SearchTermResults
                results={savedPageResults ?? queue.results}
                currentIndex={savedPageResults ? (savedPageResults.length) : queue.currentIndex}
                totalToProcess={savedPageResults ? savedPageResults.length : queue.totalToProcess}
                isAnalyzing={savedPageResults ? false : queue.isAnalyzing}
                hasMore={savedPageResults ? false : hasMore}
                canContinue={savedPageResults ? false : canContinue}
                remainingQuota={remainingQuota}
                lastSkippedCount={savedPageResults ? 0 : queue.lastSkippedCount}
                error={savedPageResults ? null : queue.error}
                onContinue={handleContinueSearchTermAnalysis}
                onReset={handleResetSearchTermMode}
                currentPage={csvCurrentPage}
                totalPages={csvParseResult ? Math.max(1, Math.ceil(csvParseResult.rows.length / 100)) : 1}
                negativeGroups={queue.accumulatedNegativeGroups}
                tokenUsage={queue.totalTokens}
                allDone={!savedPageResults && !queue.isAnalyzing && !queue.error && !hasMore && queue.results.length > 0}
                onNextPage={() => {
                  setSavedPageResults(null);
                  setCsvCurrentPage((p) => p + 1);
                  resetQueue();
                  setShowSearchTermResults(false);
                }}
              />
            </div>
          </motion.div>
        )}

        {/* Loading State */}
        <AnimatePresence>
          {analyzeMutation.isPending && (
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mt-10 text-center"
            >
              <div className="glass-card p-8 max-w-md mx-auto">
                <div className="relative w-16 h-16 mx-auto mb-5">
                  <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
                  <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  <Sparkles className="absolute inset-0 m-auto w-6 h-6 text-primary" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-2">
                  正在进行深度分析
                </h3>
                {/* Progress Bar */}
                <div className="w-full bg-secondary/60 rounded-full h-1.5 mb-3 overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-primary to-[oklch(0.55_0.22_280)] rounded-full"
                    initial={{ width: "0%" }}
                    animate={{ width: `${progress}%` }}
                    transition={{ ease: "easeOut", duration: 0.3 }}
                  />
                </div>
                <p className="text-xs text-primary font-medium mb-1">{progress}%</p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {progressLabel || "AI 正在对关键词进行语义分析，并通过搜索验证匹配度..."}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Report Section */}
        <AnimatePresence>
          {report && !analyzeMutation.isPending && (
            <motion.div
              ref={reportRef}
              initial={{ opacity: 0, y: 60 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 25, delay: 0.2 }}
              className="w-full max-w-2xl mt-6 space-y-5"
            >
              {/* Summary Card */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="glass-card p-6"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">分析总结</h3>
                    {fromCache && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">
                        <Database className="w-2.5 h-2.5" />
                        来自缓存
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {report?.analyzedAt && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="w-2.5 h-2.5" />
                        {new Date(report.analyzedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                    {(report as any)?.tokenUsage?.total_tokens > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`Prompt: ${(report as any).tokenUsage.prompt_tokens} | Completion: ${(report as any).tokenUsage.completion_tokens}`}>
                        <Sparkles className="w-2.5 h-2.5" />
                        {(report as any).tokenUsage.total_tokens.toLocaleString()} tokens
                      </span>
                    )}
                    {fromCache && (
                      <button
                        onClick={handleForceRefresh}
                        disabled={analyzeMutation.isPending}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-lg hover:bg-secondary/60"
                        title="重新分析（忽略缓存）"
                      >
                        <RefreshCw className="w-3 h-3" />
                        重新分析
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {report.overallSummary}
                </p>
                <div className="flex gap-4 mt-4 pt-4 border-t border-border/50">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-apple-green" />
                    <span className="text-xs text-muted-foreground">
                      建议保留: <strong className="text-foreground">{keepResults.length}</strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-apple-red" />
                    <span className="text-xs text-muted-foreground">
                      建议排除: <strong className="text-foreground">{excludeResults.length}</strong>
                    </span>
                  </div>
                </div>
              </motion.div>

              {/* Keep Section */}
              {keepResults.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="glass-card p-6"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-apple-green" />
                      <h3 className="text-sm font-semibold text-foreground">
                        建议保留
                      </h3>
                      <span className="text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">
                        {keepResults.length}
                      </span>
                      {selectedKeep.size > 0 && (
                        <span className="text-xs text-apple-green bg-apple-green/10 px-2 py-0.5 rounded-full">
                          已选 {selectedKeep.size}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (selectedKeep.size === keepResults.length) {
                            setSelectedKeep(new Set());
                          } else {
                            setSelectedKeep(new Set(keepResults.map((r) => r.keyword)));
                          }
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {selectedKeep.size === keepResults.length ? "取消全选" : "全选"}
                      </button>
                      {selectedKeep.size > 0 && selectedKeep.size < keepResults.length && (
                        <button
                          onClick={() => setSelectedKeep(new Set())}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          取消选择
                        </button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyKeywords("keep")}
                        className="h-8 text-xs gap-1.5 rounded-lg bg-transparent"
                      >
                        {copiedKeep ? (
                          <>
                            <Check className="w-3 h-3" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            {selectedKeep.size > 0 ? `复制所选 (${selectedKeep.size})` : "复制所有"}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {keepResults.map((result, index) => (
                      <KeywordResultCard
                        key={result.keyword + index}
                        result={result}
                        isSelected={selectedKeep.has(result.keyword)}
                        onToggleSelect={(kw) => {
                          setSelectedKeep((prev) => {
                            const next = new Set(prev);
                            if (next.has(kw)) next.delete(kw); else next.add(kw);
                            return next;
                          });
                        }}
                      />
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Exclude Section */}
              {excludeResults.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                  className="glass-card p-6"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-apple-red" />
                      <h3 className="text-sm font-semibold text-foreground">
                        建议排除
                      </h3>
                      <span className="text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">
                        {excludeResults.length}
                      </span>
                      {selectedExclude.size > 0 && (
                        <span className="text-xs text-apple-red bg-apple-red/10 px-2 py-0.5 rounded-full">
                          已选 {selectedExclude.size}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (selectedExclude.size === excludeResults.length) {
                            setSelectedExclude(new Set());
                          } else {
                            setSelectedExclude(new Set(excludeResults.map((r) => r.keyword)));
                          }
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {selectedExclude.size === excludeResults.length ? "取消全选" : "全选"}
                      </button>
                      {selectedExclude.size > 0 && selectedExclude.size < excludeResults.length && (
                        <button
                          onClick={() => setSelectedExclude(new Set())}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          取消选择
                        </button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyKeywords("exclude")}
                        className="h-8 text-xs gap-1.5 rounded-lg bg-transparent"
                      >
                        {copiedExclude ? (
                          <>
                            <Check className="w-3 h-3" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            {selectedExclude.size > 0 ? `复制所选 (${selectedExclude.size})` : "复制否词"}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Negative Match Mode Selector */}
                  <div className="flex items-center gap-2 mb-4 p-3 rounded-xl bg-secondary/40 border border-border/30">
                    <span className="text-xs text-muted-foreground shrink-0">否词模式：</span>
                    <div className="flex gap-1.5 flex-1">
                      {([
                        { value: "broad", label: "广泛匹配", preview: "abc" },
                        { value: "phrase", label: "词组匹配", preview: '"abc"' },
                        { value: "exact", label: "完全匹配", preview: "[abc]" },
                      ] as const).map((mode) => (
                        <button
                          key={mode.value}
                          onClick={() => setNegativeMatchMode(mode.value)}
                          className={`flex-1 flex flex-col items-center py-1.5 px-2 rounded-lg text-xs transition-all ${
                            negativeMatchMode === mode.value
                              ? "bg-apple-red/10 text-apple-red border border-apple-red/30 font-medium"
                              : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground border border-transparent"
                          }`}
                        >
                          <span className="font-medium">{mode.label}</span>
                          <span className={`mt-0.5 font-mono text-[10px] ${
                            negativeMatchMode === mode.value ? "opacity-80" : "opacity-50"
                          }`}>{mode.preview}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    {excludeResults.map((result, index) => (
                      <KeywordResultCard
                        key={result.keyword + index}
                        result={result}
                        negativeMatchMode={negativeMatchMode}
                        formatNegativeKeyword={formatNegativeKeyword}
                        isSelected={selectedExclude.has(result.keyword)}
                        onToggleSelect={(kw) => {
                          setSelectedExclude((prev) => {
                            const next = new Set(prev);
                            if (next.has(kw)) next.delete(kw); else next.add(kw);
                            return next;
                          });
                        }}
                      />
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Negative Insights Section */}
              {report?.negativeInsights?.hasInsights && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.65 }}
                  className="glass-card p-6"
                >
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[oklch(0.72_0.18_55)] to-[oklch(0.62_0.2_40)] flex items-center justify-center">
                      <Lightbulb className="w-3.5 h-3.5 text-white" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">智能否词提取</h3>
                    <span className="text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">
                      {report.negativeInsights.groups.length} 个分类
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4 ml-8">
                    以下词根建议以广泛匹配方式加入否词列表，可批量排除含这些词的无关搜索词
                  </p>

                  <div className="space-y-3">
                    {report.negativeInsights.groups.map((group, gIdx) => (
                      <div
                        key={`${group.category}-${gIdx}`}
                        className="rounded-xl border border-[oklch(0.72_0.18_55)]/20 bg-[oklch(0.72_0.18_55)]/[0.03] p-4"
                      >
                        {/* Group header */}
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <ShieldAlert className="w-3.5 h-3.5 text-[oklch(0.62_0.2_40)] shrink-0" />
                              <span className="text-sm font-medium text-foreground">{group.category}</span>
                            </div>
                            <p className="text-xs text-muted-foreground ml-5.5">{group.description}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyInsightGroup(group)}
                            className="h-7 text-xs gap-1 rounded-lg bg-transparent shrink-0 border-[oklch(0.72_0.18_55)]/30 text-[oklch(0.55_0.18_45)] hover:bg-[oklch(0.72_0.18_55)]/10"
                          >
                            {copiedGroups[group.category] ? (
                              <><Check className="w-3 h-3" />已复制</>
                            ) : (
                              <><Copy className="w-3 h-3" />复制广泛匹配</>
                            )}
                          </Button>
                        </div>

                        {/* Terms list */}
                        <div className="flex flex-wrap gap-1.5 ml-5.5">
                          {group.terms.map((term, tIdx) => (
                            <span
                              key={`${term}-${tIdx}`}
                              className="inline-flex items-center px-2.5 py-1 rounded-lg bg-[oklch(0.72_0.18_55)]/10 border border-[oklch(0.72_0.18_55)]/20 text-xs font-mono text-[oklch(0.5_0.18_45)]"
                            >
                              {term}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="py-8 text-center border-t border-border/30 mt-auto">
        <p className="text-xs text-muted-foreground/60 tracking-wide">
          &copy; 2026 SEM Keyword Pro. Powered by Manus
        </p>
        <p className="text-xs text-muted-foreground/40 mt-1">
          Author: Daniel LI
        </p>
      </footer>
    </div>
  );
}

/** Single keyword result card */
function KeywordResultCard({
  result,
  negativeMatchMode,
  formatNegativeKeyword,
  isSelected,
  onToggleSelect,
}: {
  result: KeywordAnalysis;
  negativeMatchMode?: "broad" | "phrase" | "exact";
  formatNegativeKeyword?: (keyword: string, mode: "broad" | "phrase" | "exact") => string;
  isSelected?: boolean;
  onToggleSelect?: (keyword: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isKeep = result.recommendation === "keep";
  const displayKeyword =
    !isKeep && negativeMatchMode && formatNegativeKeyword
      ? formatNegativeKeyword(result.keyword, negativeMatchMode)
      : result.keyword;

  return (
    <div
      className={`rounded-xl border transition-all ${
        isKeep
          ? "border-apple-green/20 bg-apple-green/[0.03]"
          : "border-apple-red/20 bg-apple-red/[0.03]"
      }`}
    >
      {/* Header — use div instead of button to avoid nested <button> from Checkbox */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
        className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
      >
        <div className="flex items-center gap-3">
          {onToggleSelect && (
            <Checkbox
              checked={isSelected ?? false}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={() => onToggleSelect(result.keyword)}
              className={isKeep ? "border-apple-green data-[state=checked]:bg-apple-green data-[state=checked]:border-apple-green" : "border-apple-red data-[state=checked]:bg-apple-red data-[state=checked]:border-apple-red"}
            />
          )}
          <Tag className={`w-3.5 h-3.5 ${isKeep ? "text-apple-green" : "text-apple-red"}`} />
          <span className={`text-sm font-medium text-foreground font-mono`}>
            {displayKeyword}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-1.5 rounded-full ${isKeep ? "bg-apple-green" : "bg-apple-red"}`}
              style={{ width: `${Math.max(20, result.confidence * 0.6)}px` }}
            />
            <span className="text-xs text-muted-foreground">{result.confidence}%</span>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </div>

      {/* Expanded Content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-border/30 pt-3">
              {/* Match indicators */}
              <div className="flex gap-3">
                <span
                  className={`text-xs px-2.5 py-1 rounded-md ${
                    result.businessTypeMatch
                      ? "bg-apple-green/10 text-apple-green"
                      : "bg-apple-red/10 text-apple-red"
                  }`}
                >
                  业务类型 {result.businessTypeMatch ? "匹配" : "不匹配"}
                </span>
                <span
                  className={`text-xs px-2.5 py-1 rounded-md ${
                    result.businessDirectionMatch
                      ? "bg-apple-green/10 text-apple-green"
                      : "bg-apple-red/10 text-apple-red"
                  }`}
                >
                  业务方向 {result.businessDirectionMatch ? "匹配" : "不匹配"}
                </span>
              </div>

              {/* Reasoning */}
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                  分析理由
                </h4>
                <p className="text-xs text-foreground/80 leading-relaxed">
                  {result.reasoning}
                </p>
              </div>

              {/* Semantic Summary */}
              {result.searchSummary && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                    语义分析摘要
                  </h4>
                  <p className="text-xs text-foreground/80 leading-relaxed">
                    {result.searchSummary}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

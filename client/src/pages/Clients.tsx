import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { safeGetLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  ArrowRight,
  Loader2,
  Users,
  Building2,
  LogOut,
  User,
  LogIn,
  ChevronLeft,
} from "lucide-react";

type BusinessType = "B2B" | "B2C";

interface ClientRecord {
  id: number;
  userId: number;
  name: string;
  businessDirection: string;
  businessType: BusinessType;
  createdAt: Date;
  updatedAt: Date;
}

interface ClientFormData {
  name: string;
  businessDirection: string;
  businessType: BusinessType;
}

const defaultFormData: ClientFormData = {
  name: "",
  businessDirection: "",
  businessType: "B2B",
};

export default function Clients() {
  const [, navigate] = useLocation();
  const { user, isAuthenticated, logout, loading: authLoading } = useAuth();

  // Redirect to login if unauthenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      const url = safeGetLoginUrl();
      if (url) window.location.href = url;
    }
  }, [authLoading, isAuthenticated]);

  // ---- Dialogs state ----
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientRecord | null>(null);
  const [formData, setFormData] = useState<ClientFormData>(defaultFormData);

  // ---- tRPC ----
  const utils = trpc.useUtils();

  const { data: clientsData, isLoading } = trpc.clients.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const createMutation = trpc.clients.create.useMutation({
    onSuccess: () => {
      toast.success("客户档案已创建");
      setShowCreateDialog(false);
      setFormData(defaultFormData);
      utils.clients.list.invalidate();
    },
    onError: (err) => toast.error("创建失败: " + err.message),
  });

  const updateMutation = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("客户档案已更新");
      setShowEditDialog(false);
      setSelectedClient(null);
      utils.clients.list.invalidate();
    },
    onError: (err) => toast.error("更新失败: " + err.message),
  });

  const deleteMutation = trpc.clients.delete.useMutation({
    onSuccess: () => {
      toast.success("客户档案已删除");
      setShowDeleteDialog(false);
      setSelectedClient(null);
      utils.clients.list.invalidate();
    },
    onError: (err) => toast.error("删除失败: " + err.message),
  });

  // ---- Handlers ----
  const handleCreate = useCallback(() => {
    if (!formData.name.trim()) {
      toast.error("请输入客户名称");
      return;
    }
    if (!formData.businessDirection.trim()) {
      toast.error("请输入业务方向");
      return;
    }
    createMutation.mutate({
      name: formData.name.trim(),
      businessDirection: formData.businessDirection.trim(),
      businessType: formData.businessType,
    });
  }, [formData, createMutation]);

  const handleUpdate = useCallback(() => {
    if (!selectedClient) return;
    if (!formData.name.trim()) {
      toast.error("请输入客户名称");
      return;
    }
    if (!formData.businessDirection.trim()) {
      toast.error("请输入业务方向");
      return;
    }
    updateMutation.mutate({
      id: selectedClient.id,
      name: formData.name.trim(),
      businessDirection: formData.businessDirection.trim(),
      businessType: formData.businessType,
    });
  }, [selectedClient, formData, updateMutation]);

  const handleDelete = useCallback(() => {
    if (!selectedClient) return;
    deleteMutation.mutate({ id: selectedClient.id });
  }, [selectedClient, deleteMutation]);

  const openEditDialog = (client: ClientRecord) => {
    setSelectedClient(client);
    setFormData({
      name: client.name,
      businessDirection: client.businessDirection,
      businessType: client.businessType,
    });
    setShowEditDialog(true);
  };

  const openDeleteDialog = (client: ClientRecord) => {
    setSelectedClient(client);
    setShowDeleteDialog(true);
  };

  const goToAnalysis = (clientId: number) => {
    navigate(`/?clientId=${clientId}`);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen apple-gradient-bg flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen apple-gradient-bg flex flex-col">
      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Plus className="w-4 h-4 text-primary" />
              新建客户档案
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">客户名称</label>
              <Input
                placeholder="例如：ABC 工业自动化"
                value={formData.name}
                onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                className="rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">业务方向</label>
              <Textarea
                placeholder="例如：工业自动化设备制造，主要销售 PLC 控制器和传感器..."
                value={formData.businessDirection}
                onChange={(e) => setFormData((f) => ({ ...f, businessDirection: e.target.value }))}
                rows={3}
                className="rounded-xl resize-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">业务类型</label>
              <div className="flex gap-2">
                {(["B2B", "B2C"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setFormData((f) => ({ ...f, businessType: type }))}
                    className={`flex-1 py-2 px-4 rounded-xl text-sm font-medium transition-all ${
                      formData.businessType === type
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
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setShowCreateDialog(false); setFormData(defaultFormData); }}
              className="rounded-xl"
            >
              取消
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="rounded-xl"
            >
              {createMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />创建中...</>
              ) : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Edit2 className="w-4 h-4 text-primary" />
              编辑客户档案
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">客户名称</label>
              <Input
                placeholder="例如：ABC 工业自动化"
                value={formData.name}
                onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                className="rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">业务方向</label>
              <Textarea
                placeholder="例如：工业自动化设备制造..."
                value={formData.businessDirection}
                onChange={(e) => setFormData((f) => ({ ...f, businessDirection: e.target.value }))}
                rows={3}
                className="rounded-xl resize-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">业务类型</label>
              <div className="flex gap-2">
                {(["B2B", "B2C"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setFormData((f) => ({ ...f, businessType: type }))}
                    className={`flex-1 py-2 px-4 rounded-xl text-sm font-medium transition-all ${
                      formData.businessType === type
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
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setShowEditDialog(false); setSelectedClient(null); }}
              className="rounded-xl"
            >
              取消
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
              className="rounded-xl"
            >
              {updateMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />保存中...</>
              ) : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除客户「{selectedClient?.name}」的档案吗？此操作不可撤销，相关的关键词历史记录也将一并删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowDeleteDialog(false)}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />删除中...</>
              ) : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Header */}
      <header className="w-full py-5 px-6">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              返回分析
            </button>
            <div className="w-px h-4 bg-border/50" />
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[oklch(0.55_0.2_260)] to-[oklch(0.45_0.22_280)] flex items-center justify-center">
                <Users className="w-4 h-4 text-white" />
              </div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                我的客户
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!authLoading && isAuthenticated && (
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
            )}
            {!authLoading && !isAuthenticated && (
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
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-6 pb-8">
        <div className="max-w-4xl mx-auto">
          {/* Page Title + New Button */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-foreground">客户档案管理</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                管理客户业务信息，分析时自动去重历史关键词
              </p>
            </div>
            <Button
              onClick={() => { setFormData(defaultFormData); setShowCreateDialog(true); }}
              className="gap-1.5 rounded-xl shadow-md shadow-primary/20"
            >
              <Plus className="w-4 h-4" />
              新建客户
            </Button>
          </div>

          {/* Client Cards */}
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !clientsData || clientsData.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-8 h-8 text-primary/60" />
              </div>
              <h3 className="text-base font-semibold text-foreground mb-2">暂无客户档案</h3>
              <p className="text-sm text-muted-foreground mb-5">
                创建客户档案后，系统将自动记录每次分析的关键词，下次分析时跳过已处理的词
              </p>
              <Button
                onClick={() => { setFormData(defaultFormData); setShowCreateDialog(true); }}
                className="gap-1.5 rounded-xl"
              >
                <Plus className="w-4 h-4" />
                创建第一个客户
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(clientsData as ClientRecord[]).map((client) => (
                <div
                  key={client.id}
                  className="glass-card p-5 flex flex-col gap-3 hover:shadow-lg transition-shadow"
                >
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="w-4 h-4 text-primary" />
                      </div>
                      <h3 className="text-sm font-semibold text-foreground truncate">
                        {client.name}
                      </h3>
                    </div>
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                        client.businessType === "B2B"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-purple-100 text-purple-700"
                      }`}
                    >
                      {client.businessType}
                    </span>
                  </div>

                  {/* Business Direction */}
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
                    {client.businessDirection}
                  </p>

                  {/* Created At */}
                  <p className="text-xs text-muted-foreground/60">
                    创建于 {new Date(client.createdAt).toLocaleDateString("zh-CN")}
                  </p>

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-1 border-t border-border/30">
                    <Button
                      size="sm"
                      onClick={() => goToAnalysis(client.id)}
                      className="flex-1 gap-1.5 rounded-xl text-xs h-8"
                    >
                      <Search className="w-3.5 h-3.5" />
                      前往分析
                      <ArrowRight className="w-3 h-3 ml-auto" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEditDialog(client)}
                      className="h-8 w-8 p-0 rounded-xl text-muted-foreground hover:text-foreground"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openDeleteDialog(client)}
                      className="h-8 w-8 p-0 rounded-xl text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-xs text-muted-foreground/50">
        2026 SEM Keyword Pro. Powered by Manus + Daniel LI
      </footer>
    </div>
  );
}

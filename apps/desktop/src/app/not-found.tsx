import { Compass } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useUiStore } from '@/shared/ui/ui-store';

export function NotFoundPage() {
  const navigate = useNavigate();
  const setCrumb = useUiStore((s) => s.setCrumb);

  // 顶栏面包屑由各页面反写：404 不写就会残留上一页的标题，层级信息与实际内容不一致
  useEffect(() => setCrumb('页面不存在'), [setCrumb]);

  return (
    <div style={{ paddingTop: 40 }}>
      <EmptyState
        icon={<Compass />}
        title="页面不存在"
        description="这个地址没有对应的页面，可能已经从注册表移除。"
        action={
          <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
            回到发现
          </button>
        }
      />
    </div>
  );
}

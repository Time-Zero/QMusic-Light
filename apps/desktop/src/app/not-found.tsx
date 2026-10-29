import { Compass } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '@/shared/ui/EmptyState';

export function NotFoundPage() {
  const navigate = useNavigate();
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

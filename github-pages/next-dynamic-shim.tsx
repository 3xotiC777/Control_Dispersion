import { useEffect, useState, type ComponentType } from "react";

type DynamicModule<Props> = { default: ComponentType<Props> } | ComponentType<Props>;

export default function dynamic<Props>(loader: () => Promise<DynamicModule<Props>>, _options?: unknown) {
  return function DynamicComponent(props: Props) {
    const [Component, setComponent] = useState<ComponentType<Props> | null>(null);

    useEffect(() => {
      let mounted = true;
      loader().then((module) => {
        const loaded = "default" in module ? module.default : module;
        if (mounted) setComponent(() => loaded);
      });
      return () => { mounted = false; };
    }, []);

    return Component ? <Component {...props} /> : null;
  };
}

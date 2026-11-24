/** The Extension Store menu: find extensions and install them. */
import { Store } from 'lucide-react';
import { ExtensionStore } from './ExtensionStore';
import './ExtensionsScreen.css';

export function ExtensionsScreen() {
  return (
    <div className="screen extensions-screen">
      <header className="screen-header">
        <Store size={16} strokeWidth={1.5} />
        <h1 className="screen-header__title">Extension Store</h1>
        <span className="screen-header__meta">Find packs of agents and skills and install them. Manage what you installed in Settings › Extensions.</span>
      </header>
      <div className="screen-body extensions-screen__body">
        <ExtensionStore />
      </div>
    </div>
  );
}

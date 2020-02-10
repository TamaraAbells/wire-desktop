/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import './Webviews.css';

import React, {Component} from 'react';

import * as EVENT_TYPE from '../lib/eventType';
import {getText} from '../lib/locale';
import Webview from './Webview';

export default class Webviews extends Component {
  constructor(props) {
    super(props);
    this.state = {
      canDelete: this._getCanDeletes(props.accounts),
    };
  }

  componentDidUpdate() {
    this.setState({canDelete: this._getCanDeletes(this.props.accounts)});
  }

  shouldComponentUpdate(nextProps, nextState) {
    for (const account of nextProps.accounts) {
      const match = this.props.accounts.find(_account => account.id === _account.id);
      if (!match) {
        return true;
      }
      // If a SSO code is set on a window, use it
      if (match.ssoCode !== account.ssoCode && account.isAdding) {
        document
          .querySelector(`Webview[data-accountid="${account.id}"]`)
          .loadURL(this._getEnvironmentUrl(account, false));
      }
      if (match.visible !== account.visible) {
        return true;
      }
    }
    return JSON.stringify(nextState.canDelete) !== JSON.stringify(this.state.canDelete);
  }

  _getCanDeletes = accounts => {
    return accounts.reduce(
      (accumulator, account) => ({
        ...accumulator,
        [account.id]: this._canDeleteWebview(account),
      }),
      {},
    );
  };

  _getEnvironmentUrl(account, forceLogin) {
    const currentLocation = new URL(window.location.href);
    const envParam = currentLocation.searchParams.get('env');
    const decodedEnvParam = decodeURIComponent(envParam);
    const url = new URL(decodedEnvParam);

    // pass account id to webview so we can access it in the preload script
    url.searchParams.set('id', account.id);

    // if there is a custom backend, add it in the url (will be removed after)
    if (account.backendOptions) {
      url.searchParams.set('backendOptions', JSON.stringify(account.backendOptions));
    }
    if (forceLogin || account.ssoCode) {
      url.pathname = '/auth';
    }
    if (forceLogin) {
      url.hash = '#login';
    }
    if (account.ssoCode && account.isAdding) {
      url.hash = `#sso/${account.ssoCode}`;
    }

    return url.href;
  }

  _accumulateBadgeCount(accounts) {
    return accounts.reduce((accumulated, account) => accumulated + account.badgeCount, 0);
  }

  _onUnreadCountUpdated = (accountId, unreadCount) => {
    this.props.updateAccountBadgeCount(accountId, unreadCount);
    const accumulatedCount = this._accumulateBadgeCount(this.props.accounts);
    window.sendBadgeCount(accumulatedCount);
  };

  _onIpcMessage = async (account, {channel, args}) => {
    switch (channel) {
      case EVENT_TYPE.ACCOUNT.CREATE_WITH_CUSTOM_BACKEND: {
        const [backendOptions] = args;
        if (!backendOptions) {
          throw Error('Custom backend options not set');
        }

        const {endpoints} = backendOptions;

        // Validate URL for each parameter
        if (!endpoints || typeof endpoints !== 'object') {
          throw Error('Invalid or missing "endpoints" key');
        }
        const requiredValues = ['backendURL', 'backendWSURL', 'blackListURL', 'teamsURL', 'accountsURL', 'websiteURL'];
        for (const requiredValue of requiredValues) {
          if (!endpoints.hasOwnProperty(requiredValue)) {
            throw Error(`Missing required value ${requiredValue}`);
          }
          endpoints[requiredValue] = new URL(endpoints[requiredValue]).toString();
        }

        const changeEnvironment = await window.authorizeBackendSwap(backendOptions);
        if (changeEnvironment) {
          this.props.deleteAccount(account.id);
          await window.sendDeleteAccount(account.id, account.sessionID);
          this.props.addAccountWithCustomBackend(backendOptions);
        }
        break;
      }

      case EVENT_TYPE.CUSTOM_BACKEND.GET_URL: {
        document
          .querySelector(`Webview[data-accountid="${account.id}"]`)
          .send(EVENT_TYPE.CUSTOM_BACKEND.GET_OPTIONS_RESPONSE, account.backendOptions);
        break;
      }

      case EVENT_TYPE.ACCOUNT.UPDATE_INFO: {
        const [accountData] = args;
        this.props.updateAccountData(account.id, accountData);
        break;
      }

      case EVENT_TYPE.ACTION.NOTIFICATION_CLICK: {
        this.props.switchAccount(account.id);
        break;
      }

      case EVENT_TYPE.LIFECYCLE.SIGNED_IN:
      case EVENT_TYPE.LIFECYCLE.SIGN_OUT: {
        this.props.updateAccountLifecycle(account.id, channel);
        break;
      }

      case EVENT_TYPE.LIFECYCLE.SIGNED_OUT: {
        const [clearData] = args;
        if (clearData) {
          this._deleteWebview(account);
        } else {
          this.props.resetIdentity(account.id);
        }
        break;
      }

      case EVENT_TYPE.LIFECYCLE.UNREAD_COUNT: {
        const [badgeCount] = args;
        this._onUnreadCountUpdated(account.id, badgeCount);
        break;
      }
    }

    this.setState({canDelete: {...this.state.canDelete, [account.id]: this._canDeleteWebview(account)}});
  };

  _onWebviewClose = account => {
    this._deleteWebview(account);
  };

  _deleteWebview = async account => {
    await window.sendDeleteAccount(account.id, account.sessionID);
    this.props.abortAccountCreation(account.id);
  };

  _canDeleteWebview = account => {
    const match = this.props.accounts.find(_account => account.id === _account.id);
    if (!match) {
      return false;
    }
    // Allow the deletion of a webview if it's the only one and
    // an account is being added and it does have a custom backend url set
    if (this.props.accounts.length <= 1 && match.isAdding && match.backendOptions) {
      return true;
    }
    // Allow the webview to be deleted if an account is being added
    if (match.isAdding && !match.userID) {
      return true;
    }
    return false;
  };

  render() {
    return (
      <ul className="Webviews">
        {this.props.accounts.map((account, index) => (
          <div className="Webviews-container" key={account.id}>
            <Webview
              className={`Webview${account.visible ? '' : ' hide'}`}
              data-accountid={account.id}
              visible={account.visible}
              src={this._getEnvironmentUrl(account, account.isAdding && index > 0)}
              partition={account.sessionID}
              onIpcMessage={event => this._onIpcMessage(account, event)}
              webpreferences="backgroundThrottling=false"
            />
            {account.visible && account.isAdding && !account.userID && account.backendOptions && (
              <div className="Webviews-third-party-server">
                {getText('thirdPartyBackendNotice')} &quot;{account.backendOptions.title}&quot;
              </div>
            )}
            {this.state.canDelete[account.id] && account.visible && (
              <div className="Webviews-close" onClick={() => this._onWebviewClose(account)}>
                <svg width="16" height="16" viewBox="0 0 16 16">
                  <path
                    d="M2.757 14.657L8 9.414l5.243 5.243 1.414-1.414L9.414 8l5.243-5.243-1.414-1.414L8 6.586 2.757 1.343 1.343 2.757 6.586 8l-5.243 5.243"
                    fillRule="evenodd"
                  />
                </svg>
              </div>
            )}
          </div>
        ))}
      </ul>
    );
  }
}

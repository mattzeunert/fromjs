import * as React from "react";

export class Fun extends React.Component<{}, { ip: string; name: string }> {
  state = {
    ip: "Loading...",
    name: "Someone"
  };

  componentDidMount() {
    fetch("https://api.ipify.org/?format=json")
      .then(r => r.json())
      .then(data => {
        this.setState({ ip: data.ip });
      });
  }

  render() {
    return (
      <div data-test-fun-things style={{ paddingBottom: 20 }}>
        <div>
          Name:{" "}
          <input
            data-test-name-input
            type="text"
            value={this.state.name}
            onChange={e => {
              this.setState({ name: e.target.value });
            }}
          />
        </div>
        <div>
          Hi {this.state.name}, your IP address is: {this.state.ip}
        </div>
      </div>
    );
  }
}
